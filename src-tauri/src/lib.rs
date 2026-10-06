mod auto_paste;
mod clipboard;
mod credentials;
#[cfg(target_os = "linux")]
mod gnome_shortcuts;
mod player;
mod recorder;
mod shortcuts;
mod state;
mod tray;

use state::{Data, HotkeyMode, Phase, Runtime, Session, Snapshot, TtsSession};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use stt_core::{load_data, save_data, OpenAiClient, OpenAiModel, Settings, Statistics, StoredData};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ToggleOrigin {
    Manual,
    Shortcut,
    Automatic,
}

impl ToggleOrigin {
    fn starts_auto_paste(self, settings: &Settings) -> bool {
        cfg!(any(target_os = "macos", target_os = "linux"))
            && settings.auto_paste
            && self == Self::Shortcut
    }

    fn finishes_auto_paste(self) -> bool {
        matches!(self, Self::Shortcut | Self::Automatic)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartupAction {
    Show,
    ToggleStt,
    ToggleTts,
    CyclePolish,
}

fn startup_action(args: impl IntoIterator<Item = impl AsRef<str>>) -> StartupAction {
    let args: Vec<_> = args
        .into_iter()
        .map(|arg| arg.as_ref().to_owned())
        .collect();
    if args.iter().any(|arg| arg == "--toggle-tts") {
        StartupAction::ToggleTts
    } else if args.iter().any(|arg| arg == "--cycle-polish") {
        StartupAction::CyclePolish
    } else if args.iter().any(|arg| arg == "--toggle") {
        StartupAction::ToggleStt
    } else {
        StartupAction::Show
    }
}

#[derive(Default)]
struct StartupQueue {
    ready: bool,
    actions: Vec<StartupAction>,
}

#[derive(Default)]
struct StartupRequests {
    queue: Mutex<StartupQueue>,
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Фоновая операция завершилась неожиданно. Повторите попытку.".to_owned())?
}

#[tauri::command]
fn get_snapshot(app: AppHandle) -> Snapshot {
    app.state::<Runtime>().snapshot()
}

#[tauri::command]
async fn list_input_devices() -> Result<Vec<recorder::InputDevice>, String> {
    blocking(recorder::list_devices).await
}

fn persistence_recovery_error(error: &str) -> String {
    format!("{error} Не удалось надёжно восстановить файл настроек. В приложении сохранены прежние настройки, но на диске могут находиться новые. Не перезапускайте приложение до успешного повторного сохранения настроек. После сохранения перезапустите приложение, если регистрация сочетаний нарушена.")
}

#[tauri::command]
async fn list_openai_models(app: AppHandle) -> Result<Vec<OpenAiModel>, String> {
    let runtime = app.state::<Runtime>();
    let key = load_models_key(&runtime, credentials::load).await?;
    runtime.client.list_models(&key).await
}

async fn load_models_key<F>(runtime: &Runtime, load: F) -> Result<Zeroizing<String>, String>
where
    F: FnOnce() -> Result<Option<Zeroizing<String>>, String> + Send + 'static,
{
    let _guard = runtime
        .control
        .try_lock()
        .map_err(|_| "Дождитесь завершения предыдущего действия.".to_owned())?;
    runtime
        .data
        .lock()
        .expect("application state poisoned")
        .ensure_idle()?;
    // Keep credential changes serialized, but release control before any HTTP request.
    blocking(load)
        .await?
        .ok_or_else(|| "Добавьте API-ключ OpenAI в настройках.".to_owned())
}

#[tauri::command]
async fn save_settings(app: AppHandle, mut settings: Settings) -> Result<Snapshot, String> {
    settings.shortcut = settings.shortcut.trim().to_owned();
    settings.tts_shortcut = settings.tts_shortcut.trim().to_owned();
    settings.polish_shortcut = settings.polish_shortcut.trim().to_owned();
    settings.tts_model = settings.tts_model.trim().to_owned();
    settings.tts_voice = settings.tts_voice.trim().to_owned();
    settings.validate()?;
    let new_shortcuts = shortcuts::validate_all(&settings)?;
    let runtime = app.state::<Runtime>();
    let _guard = runtime
        .control
        .try_lock()
        .map_err(|_| "Дождитесь завершения предыдущего действия.".to_owned())?;
    let old = {
        let data = runtime.data.lock().expect("application state poisoned");
        data.ensure_idle()?;
        data.stored.clone()
    };
    let candidate = StoredData {
        settings: settings.clone(),
        statistics: old.statistics.clone(),
    };
    let path = runtime.storage_path.clone();
    let outcome = blocking(move || save_data(&path, &candidate)).await?;
    if let Err(error) = shortcuts::replace(&app, &old.settings, &settings).await {
        let path = runtime.storage_path.clone();
        let rollback = blocking(move || save_data(&path, &old)).await;
        let error = match rollback {
            Err(_) => persistence_recovery_error(&error),
            Ok(saved) => match saved.durability_warning {
                Some(warning) => format!("{}\n{warning}", persistence_recovery_error(&error)),
                None => error,
            },
        };
        runtime
            .data
            .lock()
            .expect("application state poisoned")
            .last_error = Some(error.clone());
        tray::publish(&app);
        show_error(&app);
        return Err(error);
    }
    let accessibility_warning = settings
        .auto_paste
        .then(auto_paste::request_permission)
        .flatten();
    {
        let mut data = runtime.data.lock().expect("application state poisoned");
        data.stored.settings = settings;
        data.hotkey_available = true;
        data.hotkey_message = None;
        data.update_warning(outcome.durability_warning.or(accessibility_warning));
    }
    shortcuts::update_tts_status(&app);
    shortcuts::retain_pressed(
        &mut runtime
            .shortcut_pressed
            .lock()
            .expect("shortcut state poisoned"),
        &new_shortcuts,
    );
    tray::publish(&app);
    Ok(runtime.snapshot())
}

async fn cycle_polish_profile_runtime(runtime: &Runtime) -> Result<Snapshot, String> {
    let _guard = runtime
        .control
        .try_lock()
        .map_err(|_| "Дождитесь завершения предыдущего действия.".to_owned())?;
    let mut candidate = {
        let data = runtime.data.lock().expect("application state poisoned");
        data.ensure_idle()?;
        data.stored.clone()
    };
    candidate.settings.polish.cycle_profile();
    let saved = candidate.clone();
    let path = runtime.storage_path.clone();
    let outcome = blocking(move || save_data(&path, &saved)).await?;
    {
        let mut data = runtime.data.lock().expect("application state poisoned");
        data.stored = candidate;
        data.update_warning(outcome.durability_warning);
    }
    Ok(runtime.snapshot())
}

#[tauri::command]
async fn cycle_polish_profile(app: AppHandle) -> Result<Snapshot, String> {
    let snapshot = cycle_polish_profile_runtime(&app.state::<Runtime>()).await?;
    tray::publish(&app);
    Ok(snapshot)
}

#[tauri::command]
async fn set_api_key(app: AppHandle, api_key: String) -> Result<Snapshot, String> {
    let key = Zeroizing::new(api_key);
    let runtime = app.state::<Runtime>();
    let _guard = runtime
        .control
        .try_lock()
        .map_err(|_| "Дождитесь завершения предыдущего действия.".to_owned())?;
    runtime
        .data
        .lock()
        .expect("application state poisoned")
        .ensure_idle()?;
    blocking(move || credentials::save(&key)).await?;
    {
        let mut data = runtime.data.lock().expect("application state poisoned");
        data.has_api_key = true;
        data.update_warning(None);
    }
    tray::publish(&app);
    Ok(runtime.snapshot())
}

#[tauri::command]
async fn delete_api_key(app: AppHandle) -> Result<Snapshot, String> {
    let runtime = app.state::<Runtime>();
    let _guard = runtime
        .control
        .try_lock()
        .map_err(|_| "Дождитесь завершения предыдущего действия.".to_owned())?;
    runtime
        .data
        .lock()
        .expect("application state poisoned")
        .ensure_idle()?;
    blocking(credentials::delete).await?;
    {
        let mut data = runtime.data.lock().expect("application state poisoned");
        data.has_api_key = false;
        data.update_warning(None);
    }
    tray::publish(&app);
    Ok(runtime.snapshot())
}

#[tauri::command]
async fn reset_statistics(app: AppHandle) -> Result<Snapshot, String> {
    let runtime = app.state::<Runtime>();
    let _guard = runtime
        .control
        .try_lock()
        .map_err(|_| "Дождитесь завершения предыдущего действия.".to_owned())?;
    let mut stored = {
        let data = runtime.data.lock().expect("application state poisoned");
        data.ensure_idle()?;
        data.stored.clone()
    };
    stored.statistics = Statistics::default();
    let saved = stored.clone();
    let path = runtime.storage_path.clone();
    let outcome = blocking(move || save_data(&path, &saved)).await?;
    {
        let mut data = runtime.data.lock().expect("application state poisoned");
        data.stored = stored;
        data.update_warning(outcome.durability_warning);
    }
    tray::publish(&app);
    Ok(runtime.snapshot())
}

#[tauri::command]
async fn toggle_recording(app: AppHandle) -> Result<(), String> {
    toggle(&app, None, ToggleOrigin::Manual).await
}

async fn toggle(
    app: &AppHandle,
    expected_session: Option<u64>,
    origin: ToggleOrigin,
) -> Result<(), String> {
    let runtime = app.state::<Runtime>();
    // Do not queue key repeats into a surprise stop/start after an operation completes.
    let guard = match runtime.control.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Ok(()),
    };
    if expected_session.is_none()
        && matches!(
            runtime.snapshot().phase,
            Phase::Synthesizing | Phase::Playing
        )
    {
        stop_speech(app).await?;
    }
    let phase = {
        let data = runtime.data.lock().expect("application state poisoned");
        if let Some(expected) = expected_session {
            if data.phase != Phase::Recording
                || data.session.as_ref().map(|session| session.id) != Some(expected)
            {
                return Ok(());
            }
        }
        data.phase
    };
    match phase {
        Phase::Idle => {
            tray::publish(app);
            let settings = runtime.snapshot().settings;
            let auto_paste = origin.starts_auto_paste(&settings);
            let paste_shortcut = settings.paste_shortcut;
            let polish = settings.polish.clone();
            let started = async {
                let key = blocking(credentials::load).await?;
                let api_key = key.ok_or_else(|| {
                    "Добавьте API-ключ OpenAI в настройках перед записью.".to_owned()
                })?;
                let recorder =
                    blocking(move || recorder::Recorder::start(settings.input_device)).await?;
                Ok::<_, String>((recorder, api_key, settings.model))
            }
            .await;
            match started {
                Ok((recorder, api_key, model)) => {
                    let mut data = runtime.data.lock().expect("application state poisoned");
                    data.next_session_id = data.next_session_id.wrapping_add(1);
                    data.session = Some(Session {
                        id: data.next_session_id,
                        recorder,
                        api_key,
                        model,
                        polish,
                        auto_paste,
                        paste_shortcut,
                    });
                    data.recording_started();
                    data.has_api_key = true;
                    drop(data);
                    tray::publish(app);
                    Ok(())
                }
                Err(error) => {
                    commit_idle(app, Some(error.clone()));
                    Err(error)
                }
            }
        }
        Phase::Recording => {
            let session = {
                let mut data = runtime.data.lock().expect("application state poisoned");
                match data.session.take() {
                    Some(session) => {
                        data.phase = Phase::Transcribing;
                        data.last_error = None;
                        session
                    }
                    None => {
                        drop(data);
                        let error =
                            "Активная запись не найдена. Перезапустите приложение.".to_owned();
                        commit_idle(app, Some(error.clone()));
                        return Err(error);
                    }
                }
            };
            tray::publish(app);
            let Session {
                recorder,
                api_key,
                model,
                polish,
                auto_paste,
                paste_shortcut,
                ..
            } = session;
            let fallback_duration = recorder.duration();
            let prepared = async {
                let result = blocking(move || recorder.finish()).await;
                let seconds = result
                    .as_ref()
                    .map(|audio| audio.duration())
                    .unwrap_or(fallback_duration);
                add_statistics(app, seconds).await;
                let audio = result?;
                blocking(move || stt_core::encode_wav(&audio.mono_samples, audio.sample_rate)).await
            }
            .await;
            drop(guard);
            let recognized = match prepared {
                Ok(wav) => runtime.client.transcribe(&api_key, &model, wav).await,
                Err(error) => Err(error),
            };
            let processed = match recognized {
                Ok(raw) => {
                    let selected = runtime
                        .data
                        .lock()
                        .expect("application state poisoned")
                        .accept_transcript(raw.clone(), polish.clone());
                    tray::publish(app);
                    match selected {
                        Ok(true) => runtime.client.polish(&api_key, &polish, &raw).await,
                        Ok(false) => Ok(raw),
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            };
            // Finalize under the control lock: readiness, result and error are one commit.
            let _completion = runtime.control.lock().await;
            let result = match processed {
                Ok(text) => {
                    let _clipboard = runtime.clipboard.lock().await;
                    runtime
                        .data
                        .lock()
                        .expect("application state poisoned")
                        .accept_output(text.clone());
                    match clipboard::write_text(app, text).await {
                        Ok(()) if auto_paste && origin.finishes_auto_paste() => {
                            auto_paste::paste(paste_shortcut).await
                        }
                        result => result,
                    }
                }
                Err(error) => Err(error),
            };
            commit_idle(app, result.as_ref().err().cloned());
            result
        }
        Phase::Transcribing | Phase::Polishing | Phase::Synthesizing | Phase::Playing => Ok(()),
    }
}

// Prefer cancellation even when the operation becomes ready in the same poll.
async fn cancellable<T>(
    cancellation: &mut tokio::sync::watch::Receiver<bool>,
    work: impl std::future::Future<Output = T>,
) -> Option<T> {
    use std::future::{poll_fn, Future};
    use std::task::Poll;
    if *cancellation.borrow() {
        return None;
    }
    let mut cancelled = std::pin::pin!(cancellation.changed());
    let mut work = std::pin::pin!(work);
    poll_fn(|cx| {
        if cancelled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        work.as_mut().poll(cx).map(Some)
    })
    .await
}

async fn release_preparation<T, Release, Released>(
    prepared: Result<T, String>,
    acknowledgement: tokio::sync::watch::Sender<Option<Result<(), String>>>,
    release: Release,
) where
    Release: FnOnce(T) -> Released,
    Released: std::future::Future<Output = Result<(), String>>,
{
    let result = match prepared {
        Ok(resource) => release(resource).await,
        Err(_) => Ok(()),
    };
    let _ = acknowledgement.send(Some(result));
}

async fn cancellable_prepare<T, Prepare, Release, Released>(
    cancellation: &mut tokio::sync::watch::Receiver<bool>,
    prepare: Prepare,
    acknowledgement: tokio::sync::watch::Sender<Option<Result<(), String>>>,
    release: Release,
) -> Option<(
    Result<T, String>,
    tokio::sync::watch::Sender<Option<Result<(), String>>>,
)>
where
    Prepare: std::future::Future<Output = Result<T, String>>,
    Release: FnOnce(T) -> Released,
    Released: std::future::Future<Output = Result<(), String>>,
{
    let mut prepare = std::pin::pin!(prepare);
    let prepared = cancellable(cancellation, prepare.as_mut()).await;
    match prepared {
        Some(prepared) => Some((prepared, acknowledgement)),
        None => {
            release_preparation(prepare.await, acknowledgement, release).await;
            None
        }
    }
}

enum ControlCommit<Committed, Cancelled> {
    Committed(Committed),
    Cancelled(Cancelled),
}

async fn cancellable_commit<Resource, Committed>(
    control: &tokio::sync::Mutex<()>,
    cancellation: &mut tokio::sync::watch::Receiver<bool>,
    resource: Resource,
    commit: impl FnOnce(Resource) -> Committed,
) -> ControlCommit<Committed, Resource> {
    let mut locking = std::pin::pin!(control.lock());
    let Some(guard) = cancellable(cancellation, locking.as_mut()).await else {
        return ControlCommit::Cancelled(resource);
    };
    let committed = commit(resource);
    drop(guard);
    ControlCommit::Committed(committed)
}

enum PreparationCommit {
    Ready(player::Completion),
    Error(String),
    Stale(
        Result<player::Player, String>,
        tokio::sync::watch::Sender<Option<Result<(), String>>>,
    ),
}

#[tauri::command]
async fn toggle_speech(app: AppHandle) -> Result<(), String> {
    let runtime = app.state::<Runtime>();
    let _guard = match runtime.control.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Ok(()),
    };
    match runtime.snapshot().phase {
        Phase::Synthesizing | Phase::Playing => return stop_speech(&app).await,
        Phase::Idle => {}
        _ => return Ok(()),
    }
    let (id, mut cancellation, settings) = {
        let mut data = runtime.data.lock().expect("application state poisoned");
        data.next_tts_session_id = data.next_tts_session_id.wrapping_add(1);
        let id = data.next_tts_session_id;
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        data.tts_session = Some(TtsSession {
            id,
            cancel,
            preparation: None,
            player: None,
        });
        data.phase = Phase::Synthesizing;
        data.last_error = None;
        (id, receiver, data.stored.settings.clone())
    };
    tray::publish(&app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let runtime = app.state::<Runtime>();
        let synthesis = async {
            let text = {
                let _clipboard = runtime.clipboard.lock().await;
                clipboard::read_text(&app).await?
            };
            let key = blocking(credentials::load).await?.ok_or_else(|| {
                "Добавьте API-ключ OpenAI в настройках перед озвучиванием.".to_owned()
            })?;
            runtime
                .client
                .synthesize(&key, &settings.tts_model, &settings.tts_voice, &text)
                .await
        };
        let Some(wav) = cancellable(&mut cancellation, synthesis).await else {
            return;
        };
        let (preparation_acknowledgement, preparation_completion) =
            tokio::sync::watch::channel(None);
        {
            let mut data = runtime.data.lock().expect("application state poisoned");
            if !data.register_tts_preparation(id, *cancellation.borrow(), preparation_completion) {
                return;
            }
        }
        let started = match wav {
            Ok(wav) => {
                let Some(started) = cancellable_prepare(
                    &mut cancellation,
                    blocking(move || player::Player::prepare(wav)),
                    preparation_acknowledgement,
                    |player| async move {
                        let completion = player.completion();
                        player.stop();
                        drop(player);
                        player::wait_for_completion(completion).await
                    },
                )
                .await
                else {
                    return;
                };
                started
            }
            Err(error) => (Err(error), preparation_acknowledgement),
        };
        let (started, preparation_acknowledgement) = started;
        let committed = cancellable_commit(
            &runtime.control,
            &mut cancellation,
            (started, preparation_acknowledgement),
            |(started, preparation_acknowledgement)| {
                let mut data = runtime.data.lock().expect("application state poisoned");
                if !data.tts_active(id) {
                    return PreparationCommit::Stale(started, preparation_acknowledgement);
                }
                let player = match started {
                    Ok(player) => player,
                    Err(error) => {
                        data.tts_session
                            .as_mut()
                            .expect("active TTS session")
                            .preparation = None;
                        drop(preparation_acknowledgement);
                        return PreparationCommit::Error(error);
                    }
                };
                let completion = player.completion();
                let session = data.tts_session.as_mut().expect("active TTS session");
                session.preparation = None;
                session.player = Some(player);
                drop(preparation_acknowledgement);
                PreparationCommit::Ready(completion)
            },
        )
        .await;
        let completion = match committed {
            ControlCommit::Cancelled((started, acknowledgement))
            | ControlCommit::Committed(PreparationCommit::Stale(started, acknowledgement)) => {
                release_preparation(started, acknowledgement, |player| async move {
                    let completion = player.completion();
                    player.stop();
                    drop(player);
                    player::wait_for_completion(completion).await
                })
                .await;
                return;
            }
            ControlCommit::Committed(PreparationCommit::Error(error)) => {
                let _guard = runtime.control.lock().await;
                finish_tts(&app, id, Some(error));
                return;
            }
            ControlCommit::Committed(PreparationCommit::Ready(completion)) => completion,
        };
        let play_result = {
            let mut data = runtime.data.lock().expect("application state poisoned");
            if !data.tts_active(id) {
                return;
            }
            let result = data
                .tts_session
                .as_ref()
                .and_then(|session| session.player.as_ref())
                .expect("committed player")
                .play();
            if result.is_ok() {
                data.phase = Phase::Playing;
            }
            result
        };
        if let Err(error) = play_result {
            let _ = stop_speech_generation(&app, Some(id), Some(error)).await;
            return;
        }
        tray::publish(&app);
        let Some(result) = cancellable(
            &mut cancellation,
            player::wait_for_completion(completion.clone()),
        )
        .await
        else {
            return;
        };
        let _guard = runtime.control.lock().await;
        finish_tts(&app, id, result.err());
    });
    Ok(())
}

const PLAYER_STOP_TIMEOUT: Duration = Duration::from_secs(3);

// Never hold the data mutex while waiting for device release. Calls from command paths are
// serialized by control; the committed-player error path is generation-safe without it.
async fn stop_speech(app: &AppHandle) -> Result<(), String> {
    stop_speech_generation(app, None, None).await
}

fn combined_error(primary: Option<String>, secondary: String) -> String {
    primary
        .map(|primary| format!("{primary}\n{secondary}"))
        .unwrap_or(secondary)
}

async fn stop_speech_generation(
    app: &AppHandle,
    expected_id: Option<u64>,
    final_error: Option<String>,
) -> Result<(), String> {
    let runtime = app.state::<Runtime>();
    let requested = runtime
        .data
        .lock()
        .expect("application state poisoned")
        .request_tts_stop(expected_id);
    let Some((id, completion)) = requested else {
        return Ok(());
    };
    if let Some(completion) = completion {
        if let Err(error) = acknowledged_stop(completion.clone(), PLAYER_STOP_TIMEOUT).await {
            // A terminal playback error still confirms resource release.
            if completion.borrow().is_some() {
                finish_tts(app, id, Some(combined_error(final_error, error.clone())));
                return Err(error);
            }
            let mut data = runtime.data.lock().expect("application state poisoned");
            if data.tts_active(id) {
                data.last_error = Some(combined_error(final_error, error.clone()));
            }
            drop(data);
            tray::publish(app);
            show_error(app);
            return Err(error);
        }
    }
    finish_tts(app, id, final_error);
    Ok(())
}

async fn acknowledged_stop(
    completion: player::Completion,
    timeout: Duration,
) -> Result<(), String> {
    tokio::time::timeout(timeout, player::wait_for_completion(completion)).await
        .map_err(|_| "Не удалось подтвердить остановку и освобождение аудиоустройства. Новая операция заблокирована. Повторите остановку; если ошибка сохраняется, перезапустите приложение.".to_owned())?
}

// Only the active generation may publish a result or an error.
fn finish_tts(app: &AppHandle, id: u64, error: Option<String>) {
    let runtime = app.state::<Runtime>();
    let mut data = runtime.data.lock().expect("application state poisoned");
    if !data.tts_active(id) {
        return;
    }
    // This also rejects missing acknowledgements even if the completion channel closed.
    data.complete_tts(id, error);
    let has_error = data.last_error.is_some();
    drop(data);
    tray::publish(app);
    if has_error {
        show_error(app);
    }
}

pub(crate) fn spawn_speech(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = toggle_speech(app).await;
    });
}

#[tauri::command]
async fn retry_polish(app: AppHandle) -> Result<(), String> {
    let runtime = app.state::<Runtime>();
    let guard = runtime
        .control
        .try_lock()
        .map_err(|_| "Дождитесь завершения предыдущего действия.".to_owned())?;
    // Reject busy/no-job requests without altering their error or result state.
    runtime
        .data
        .lock()
        .expect("application state poisoned")
        .retry_job()?;
    let key = match blocking(credentials::load).await {
        Ok(Some(key)) => key,
        result => {
            let error = result
                .err()
                .unwrap_or_else(|| "Добавьте API-ключ OpenAI для повторной обработки.".into());
            commit_idle(&app, Some(error.clone()));
            return Err(error);
        }
    };
    let (raw, settings) = runtime
        .data
        .lock()
        .expect("application state poisoned")
        .begin_retry()?;
    tray::publish(&app);
    drop(guard);
    let polished = runtime.client.polish(&key, &settings, &raw).await;
    let _completion = runtime.control.lock().await;
    let result = match polished {
        Ok(text) => {
            runtime
                .data
                .lock()
                .expect("application state poisoned")
                .accept_output(text.clone());
            let _clipboard = runtime.clipboard.lock().await;
            // A retry may run in a different focused application: never synthesize paste.
            clipboard::write_text(&app, text).await
        }
        Err(error) => Err(error),
    };
    commit_idle(&app, result.as_ref().err().cloned());
    result
}

async fn add_statistics(app: &AppHandle, seconds: f64) {
    if seconds <= 0.0 {
        return;
    }
    let runtime = app.state::<Runtime>();
    let candidate = {
        let mut data = runtime.data.lock().expect("application state poisoned");
        if let Err(error) = data.stored.statistics.add_recording(seconds) {
            data.last_error = Some(error);
            return;
        }
        data.stored.clone()
    };
    let path = runtime.storage_path.clone();
    let warning = match blocking(move || save_data(&path, &candidate)).await {
        Ok(outcome) => outcome.durability_warning,
        Err(_) => Some("Не удалось сохранить статистику на диск. Значения доступны до закрытия приложения; проверьте доступ к каталогу данных.".into()),
    };
    if let Some(warning) = warning {
        runtime
            .data
            .lock()
            .expect("application state poisoned")
            .last_error = Some(warning);
    }
}

// Call only while holding Runtime.control. An older operation must not modify a new session.
fn commit_idle(app: &AppHandle, error: Option<String>) {
    let runtime = app.state::<Runtime>();
    let has_error = {
        let mut data = runtime.data.lock().expect("application state poisoned");
        data.phase = Phase::Idle;
        data.session = None;
        if let Some(error) = error {
            data.last_error = Some(match data.last_error.take() {
                Some(previous) if previous != error => format!("{previous}\n{error}"),
                _ => error,
            });
        }
        data.last_error.is_some()
    };
    tray::publish(app);
    if has_error {
        show_error(app);
    }
}

fn show_error(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let snapshot = handle.state::<Runtime>().snapshot();
        if snapshot.last_error.is_some() {
            tray::show_window(&handle);
        }
    });
}

#[tauri::command]
async fn cancel_recording(app: AppHandle) -> Result<(), String> {
    cancel(&app, None, None).await
}

async fn cancel(
    app: &AppHandle,
    expected_session: Option<u64>,
    reason: Option<String>,
) -> Result<(), String> {
    let runtime = app.state::<Runtime>();
    let _guard = match runtime.control.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Ok(()),
    };
    let session = {
        let mut data = runtime.data.lock().expect("application state poisoned");
        if data.phase != Phase::Recording {
            return Ok(());
        }
        if let Some(expected) = expected_session {
            if data.session.as_ref().map(|session| session.id) != Some(expected) {
                return Ok(());
            }
        }
        data.session.take()
    };
    let mut result = Ok(());
    if let Some(session) = session {
        let seconds = session.recorder.duration();
        // The worker acknowledges only after dropping its stream. Do not claim readiness
        // on a reply timeout while the microphone might still be open.
        let finished = blocking(move || session.recorder.finish()).await;
        let duration = finished
            .as_ref()
            .map(|audio| audio.duration())
            .unwrap_or(seconds);
        result = finished.map(|_| ());
        add_statistics(app, duration).await;
    }
    let error = reason.or_else(|| result.as_ref().err().cloned());
    commit_idle(app, error);
    result
}

#[tauri::command]
async fn copy_last_transcript(app: AppHandle) -> Result<(), String> {
    let runtime = app.state::<Runtime>();
    let _guard = runtime
        .control
        .try_lock()
        .map_err(|_| "Дождитесь завершения предыдущего действия.".to_owned())?;
    runtime
        .data
        .lock()
        .expect("application state poisoned")
        .ensure_idle()?;
    let _clipboard = runtime.clipboard.lock().await;
    let text = runtime
        .snapshot()
        .last_transcript
        .ok_or_else(|| "Пока нет результата для копирования.".to_owned())?;
    let result = clipboard::write_text(&app, text).await;
    if let Err(error) = &result {
        commit_idle(&app, Some(error.clone()));
    }
    result
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    shutdown(&app);
}

pub(crate) fn shutdown(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<Runtime>() {
        let mut data = runtime.data.lock().expect("application state poisoned");
        data.stop_tts();
        let session = data.session.take();
        drop(data);
        drop(session);
    }
    app.exit(0);
}

pub(crate) fn spawn_toggle(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = toggle_recording(app).await;
    });
}

fn spawn_shortcut_toggle(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = toggle(&app, None, ToggleOrigin::Shortcut).await;
    });
}

pub(crate) fn spawn_cancel(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = cancel_recording(app).await;
    });
}

pub(crate) fn spawn_copy(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = copy_last_transcript(app).await;
    });
}

fn monitor_microphone(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let observed = {
                let runtime = app.state::<Runtime>();
                let data = runtime.data.lock().expect("application state poisoned");
                data.session.as_ref().map(|session| {
                    (
                        session.id,
                        session.recorder.problem(),
                        session.recorder.limit_reached(),
                    )
                })
            };
            if let Some((id, problem, limit)) = observed {
                if let Some(error) = problem {
                    let _ = cancel(&app, Some(id), Some(error)).await;
                } else if limit {
                    let _ = toggle(&app, Some(id), ToggleOrigin::Automatic).await;
                }
            }
        }
    });
}

fn shortcut_action(
    settings: &Settings,
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
) -> Option<StartupAction> {
    if shortcuts::validate(&settings.shortcut).ok().as_ref() == Some(shortcut) {
        Some(StartupAction::ToggleStt)
    } else if shortcuts::validate(&settings.tts_shortcut).ok().as_ref() == Some(shortcut) {
        Some(StartupAction::ToggleTts)
    } else if shortcuts::validate(&settings.polish_shortcut).ok().as_ref() == Some(shortcut) {
        Some(StartupAction::CyclePolish)
    } else {
        None
    }
}

fn dispatch_request(app: &AppHandle, action: StartupAction) {
    match action {
        StartupAction::ToggleStt => spawn_shortcut_toggle(app.clone()),
        StartupAction::ToggleTts => spawn_speech(app.clone()),
        StartupAction::CyclePolish => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = cycle_polish_profile(handle).await;
            });
        }
        StartupAction::Show => {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || tray::show_window(&handle));
        }
    }
}

pub fn run() {
    let wayland = clipboard::is_wayland();
    let mut builder = tauri::Builder::default()
        .manage(StartupRequests::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let action = startup_action(&args);
            let requests = app.state::<StartupRequests>();
            let mut queue = requests.queue.lock().expect("startup queue poisoned");
            if !queue.ready {
                queue.actions.push(action);
                return;
            }
            drop(queue);
            dispatch_request(app, action);
        }))
        .plugin(tauri_plugin_clipboard_manager::init());
    if !wayland {
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let runtime = match app.try_state::<Runtime>() {
                        Some(runtime) => runtime,
                        None => return,
                    };
                    let settings = runtime.snapshot().settings;
                    let Some(action) = shortcut_action(&settings, shortcut) else {
                        return;
                    };
                    let mut pressed = runtime
                        .shortcut_pressed
                        .lock()
                        .expect("shortcut state poisoned");
                    match event.state() {
                        ShortcutState::Pressed if pressed.insert(*shortcut) => {
                            dispatch_request(app, action);
                        }
                        ShortcutState::Released => {
                            pressed.remove(shortcut);
                        }
                        _ => {}
                    }
                })
                .build(),
        );
    }
    builder
        .setup(move |app| {
            let handle = app.handle().clone();
            let storage_path = app.path().app_data_dir()?.join("settings.json");
            let (stored, storage_error) = match load_data(&storage_path) {
                Ok(stored) => (stored, None),
                Err(error) => (StoredData::default(), Some(error)),
            };
            let (has_api_key, credential_error) = match credentials::load() {
                Ok(key) => (key.is_some(), None),
                Err(error) => (false, Some(error)),
            };
            let last_error = match (storage_error, credential_error) {
                (Some(a), Some(b)) => Some(format!("{a}\n{b}")),
                (a, b) => a.or(b),
            };
            let client = OpenAiClient::new().map_err(std::io::Error::other)?;
            app.manage(Runtime {
                data: Mutex::new(Data { tts_session: None, next_tts_session_id: 0,
                    tts_hotkey_available: false, tts_hotkey_command: None, tts_hotkey_message: None,
                    polish_hotkey_available: false, polish_hotkey_command: if wayland { Some(shortcuts::wayland_polish_command()) } else { None }, polish_hotkey_message: None,
                    stored, phase: Phase::Idle, session: None, next_session_id: 0,
                    last_transcript: None, last_raw_transcript: None, pending_polish: None, last_error, has_api_key,
                    hotkey_available: false, hotkey_message: None,
                    hotkey_mode: if wayland { HotkeyMode::System } else { HotkeyMode::Native },
                    hotkey_command: if wayland { Some(shortcuts::wayland_command()) } else { None } }),
                control: tokio::sync::Mutex::new(()),
                clipboard: tokio::sync::Mutex::new(()),
                shortcut_pressed: Mutex::new(HashSet::new()),
                client, storage_path,
            });
            if tray::initialize(&handle).is_err() {
                handle.state::<Runtime>().data.lock().expect("application state poisoned").last_error = Some("Не удалось создать индикатор трея. Проверьте поддержку AppIndicator в GNOME; окно приложения оставлено открытым.".into());
            }
            shortcuts::initialize(&handle);
            tray::publish(&handle);
            monitor_microphone(handle.clone());
            dispatch_request(&handle, startup_action(std::env::args()));
            if handle.tray_by_id("status").is_none() { tray::show_window(&handle); }
            let requests = handle.state::<StartupRequests>();
            let pending = {
                let mut queue = requests.queue.lock().expect("startup queue poisoned");
                queue.ready = true;
                std::mem::take(&mut queue.actions)
            };
            for action in pending { dispatch_request(&handle, action); }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if cfg!(target_os = "linux") {
                    // A tray handle does not prove GNOME has a visible AppIndicator extension.
                    api.prevent_close();
                    let _ = window.minimize();
                } else if window.app_handle().tray_by_id("status").is_some() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![get_snapshot, list_input_devices, list_openai_models,
            save_settings, cycle_polish_profile, set_api_key, delete_api_key, reset_statistics,
            toggle_recording, toggle_speech, cancel_recording, copy_last_transcript, retry_polish, quit_app])
        .run(tauri::generate_context!())
        .expect("failed to run STT Simple");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models_runtime(phase: Phase) -> Runtime {
        Runtime {
            data: Mutex::new(Data {
                tts_session: None,
                next_tts_session_id: 0,
                tts_hotkey_available: false,
                tts_hotkey_command: None,
                tts_hotkey_message: None,
                polish_hotkey_available: false,
                polish_hotkey_command: None,
                polish_hotkey_message: None,
                stored: StoredData::default(),
                phase,
                session: None,
                next_session_id: 0,
                last_transcript: Some("previous".into()),
                last_raw_transcript: None,
                pending_polish: None,
                last_error: Some("previous error".into()),
                has_api_key: false,
                hotkey_available: false,
                hotkey_message: None,
                hotkey_mode: HotkeyMode::Native,
                hotkey_command: None,
            }),
            control: tokio::sync::Mutex::new(()),
            clipboard: tokio::sync::Mutex::new(()),
            shortcut_pressed: Mutex::new(HashSet::new()),
            client: OpenAiClient::new().unwrap(),
            storage_path: Default::default(),
        }
    }

    fn cycle_runtime(phase: Phase, storage_path: std::path::PathBuf) -> Runtime {
        let mut runtime = models_runtime(phase);
        runtime.storage_path = storage_path;
        runtime
    }

    fn test_storage_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "stt-simple-{name}-{}-settings.json",
            std::process::id()
        ))
    }

    #[test]
    fn cycle_polish_profile_persists_before_committing_and_cycles_to_off() {
        tauri::async_runtime::block_on(async {
            let path = test_storage_path("cycle-profile");
            let _ = std::fs::remove_file(&path);
            let runtime = cycle_runtime(Phase::Idle, path.clone());
            {
                let mut data = runtime.data.lock().unwrap();
                data.stored.settings.polish.favorite_profile_ids =
                    vec!["polish".into(), "markdown".into()];
            }

            let snapshot = cycle_polish_profile_runtime(&runtime).await.unwrap();
            assert_eq!(
                snapshot.settings.polish.profile_id.as_deref(),
                Some("polish")
            );
            assert_eq!(
                load_data(&path)
                    .unwrap()
                    .settings
                    .polish
                    .profile_id
                    .as_deref(),
                Some("polish")
            );

            runtime
                .data
                .lock()
                .unwrap()
                .stored
                .settings
                .polish
                .profile_id = Some("markdown".into());
            let snapshot = cycle_polish_profile_runtime(&runtime).await.unwrap();
            assert_eq!(snapshot.settings.polish.profile_id, None);
            assert_eq!(load_data(&path).unwrap().settings.polish.profile_id, None);
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn cycle_polish_profile_with_no_favorites_returns_off() {
        tauri::async_runtime::block_on(async {
            let path = test_storage_path("cycle-empty");
            let _ = std::fs::remove_file(&path);
            let runtime = cycle_runtime(Phase::Idle, path.clone());
            let snapshot = cycle_polish_profile_runtime(&runtime).await.unwrap();
            assert_eq!(snapshot.settings.polish.profile_id, None);
            assert_eq!(load_data(&path).unwrap().settings.polish.profile_id, None);
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn cycle_polish_profile_rejects_busy_phases_without_changing_disk_or_memory() {
        tauri::async_runtime::block_on(async {
            for phase in [
                Phase::Recording,
                Phase::Transcribing,
                Phase::Polishing,
                Phase::Synthesizing,
                Phase::Playing,
            ] {
                let path = test_storage_path(&format!("cycle-busy-{}", phase as u8));
                let _ = std::fs::remove_file(&path);
                let runtime = cycle_runtime(phase, path.clone());
                runtime
                    .data
                    .lock()
                    .unwrap()
                    .stored
                    .settings
                    .polish
                    .favorite_profile_ids = vec!["polish".into()];
                assert!(cycle_polish_profile_runtime(&runtime).await.is_err());
                assert_eq!(
                    runtime
                        .data
                        .lock()
                        .unwrap()
                        .stored
                        .settings
                        .polish
                        .profile_id,
                    None
                );
                assert!(!path.exists());
            }
        });
    }

    #[test]
    fn cycle_polish_profile_preserves_memory_after_persistence_failure() {
        tauri::async_runtime::block_on(async {
            let parent = test_storage_path("cycle-failure-parent");
            let _ = std::fs::remove_file(&parent);
            std::fs::write(&parent, b"not a directory").unwrap();
            let runtime = cycle_runtime(Phase::Idle, parent.join("settings.json"));
            runtime
                .data
                .lock()
                .unwrap()
                .stored
                .settings
                .polish
                .favorite_profile_ids = vec!["polish".into()];

            assert!(cycle_polish_profile_runtime(&runtime).await.is_err());
            let polish = &runtime.data.lock().unwrap().stored.settings.polish;
            assert_eq!(polish.profile_id, None);
            assert_eq!(polish.favorite_profile_ids, vec!["polish"]);
            let _ = std::fs::remove_file(parent);
        });
    }

    #[test]
    fn models_credentials_require_idle_and_control_before_loading() {
        tauri::async_runtime::block_on(async {
            for phase in [
                Phase::Recording,
                Phase::Transcribing,
                Phase::Polishing,
                Phase::Synthesizing,
                Phase::Playing,
            ] {
                let runtime = models_runtime(phase);
                assert!(
                    load_models_key(&runtime, || panic!("must not load while busy"))
                        .await
                        .is_err()
                );
                assert!(runtime.control.try_lock().is_ok());
            }
            let runtime = models_runtime(Phase::Idle);
            let guard = runtime.control.lock().await;
            assert!(
                load_models_key(&runtime, || panic!("must not load without control"))
                    .await
                    .is_err()
            );
            drop(guard);
        });
    }

    #[test]
    fn models_credentials_release_control_and_preserve_state() {
        tauri::async_runtime::block_on(async {
            let runtime = std::sync::Arc::new(models_runtime(Phase::Idle));
            let loading = runtime.clone();
            let key = load_models_key(&runtime, move || {
                assert!(loading.control.try_lock().is_err());
                assert!(loading.data.try_lock().is_ok());
                Ok(Some(Zeroizing::new("test-key".into())))
            })
            .await
            .unwrap();
            assert_eq!(key.as_str(), "test-key");
            // The caller can now await HTTP without blocking recording/settings commands.
            assert!(runtime.control.try_lock().is_ok());
            assert!(load_models_key(&runtime, || Ok(None)).await.is_err());
            assert_eq!(
                load_models_key(&runtime, || Err("keyring unavailable".into()))
                    .await
                    .unwrap_err(),
                "keyring unavailable"
            );
            assert!(runtime.control.try_lock().is_ok());
            let data = runtime.data.lock().unwrap();
            assert!(data.phase == Phase::Idle);
            assert_eq!(data.stored.settings, Settings::default());
            assert_eq!(data.stored.statistics.recordings, 0);
            assert_eq!(data.last_transcript.as_deref(), Some("previous"));
            assert_eq!(data.last_error.as_deref(), Some("previous error"));
            assert!(!data.has_api_key);
        });
    }

    #[test]
    fn stop_acknowledgement_is_required_and_bounded() {
        tauri::async_runtime::block_on(async {
            let (sender, observer) = tokio::sync::watch::channel(None);
            let mut wait =
                std::pin::pin!(acknowledged_stop(observer.clone(), Duration::from_secs(1)));
            std::future::poll_fn(|cx| {
                assert!(std::future::Future::poll(wait.as_mut(), cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            sender.send(Some(Ok(()))).unwrap();
            assert!(wait.await.is_ok());
            assert!(acknowledged_stop(observer, Duration::ZERO).await.is_ok());
            let (_sender, observer) = tokio::sync::watch::channel(None);
            let error = acknowledged_stop(observer, Duration::ZERO)
                .await
                .unwrap_err();
            assert!(error.contains("Новая операция заблокирована"));
            let (sender, observer) = tokio::sync::watch::channel(None);
            drop(sender);
            assert!(acknowledged_stop(observer, Duration::from_secs(1))
                .await
                .is_err());
        });
    }

    #[test]
    fn cancellation_during_prepare_waits_for_resource_release_acknowledgement() {
        tauri::async_runtime::block_on(async {
            let (cancel, mut cancellation) = tokio::sync::watch::channel(false);
            let (prepared, preparation) = tokio::sync::oneshot::channel::<()>();
            let (release_started, release_observer) = tokio::sync::oneshot::channel();
            let (release_finished, release_wait) = tokio::sync::oneshot::channel();
            let (acknowledgement, completion) = tokio::sync::watch::channel(None);

            let worker = tauri::async_runtime::spawn(async move {
                cancellable_prepare(
                    &mut cancellation,
                    async move {
                        preparation
                            .await
                            .map_err(|_| "prepare dropped".to_owned())?;
                        Ok(())
                    },
                    acknowledgement,
                    move |()| async move {
                        release_started.send(()).unwrap();
                        release_wait
                            .await
                            .map_err(|_| "release dropped".to_owned())?;
                        Ok(())
                    },
                )
                .await
            });

            cancel.send(true).unwrap();
            let mut stop = std::pin::pin!(acknowledged_stop(completion, Duration::from_secs(1)));
            std::future::poll_fn(|cx| {
                assert!(std::future::Future::poll(stop.as_mut(), cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;

            prepared.send(()).unwrap();
            release_observer.await.unwrap();
            std::future::poll_fn(|cx| {
                assert!(std::future::Future::poll(stop.as_mut(), cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;

            release_finished.send(()).unwrap();
            assert!(stop.await.is_ok());
            assert!(worker.await.unwrap().is_none());
        });
    }

    #[test]
    fn control_is_released_after_commit_for_stop_and_final_completion() {
        tauri::async_runtime::block_on(async {
            let control = std::sync::Arc::new(tokio::sync::Mutex::new(()));
            let (_cancel, mut cancellation) = tokio::sync::watch::channel(false);
            let (committed, commit_observer) = tokio::sync::oneshot::channel();
            let (playback_finished, playback_wait) = tokio::sync::oneshot::channel();
            let (final_locking, final_lock_observer) = tokio::sync::oneshot::channel();
            let (finalized, mut final_observer) = tokio::sync::oneshot::channel();
            let worker_control = control.clone();

            let worker = tauri::async_runtime::spawn(async move {
                let committed_resource =
                    cancellable_commit(&worker_control, &mut cancellation, (), |()| {
                        committed.send(()).unwrap();
                        42
                    })
                    .await;
                assert!(matches!(committed_resource, ControlCommit::Committed(42)));

                playback_wait.await.unwrap();
                final_locking.send(()).unwrap();
                let _final_guard = worker_control.lock().await;
                finalized.send(()).unwrap();
            });

            commit_observer.await.unwrap();
            let stop_guard = control
                .try_lock()
                .expect("control must be released immediately after commit");
            playback_finished.send(()).unwrap();
            final_lock_observer.await.unwrap();
            assert!(matches!(
                final_observer.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ));

            drop(stop_guard);
            final_observer.await.unwrap();
            worker.await.unwrap();
        });
    }

    #[test]
    fn persistence_failure_recovery_advises_saving_before_restart() {
        let message = persistence_recovery_error("Регистрация не удалась.");
        assert!(message.contains("В приложении сохранены прежние настройки"));
        assert!(message.contains("на диске могут находиться новые"));
        assert!(message.contains("Не перезапускайте приложение до успешного повторного сохранения"));
    }

    #[test]
    fn cancellation_wins_over_ready_result_and_drops_pending_work() {
        tauri::async_runtime::block_on(async {
            let (sender, mut receiver) = tokio::sync::watch::channel(false);
            assert_eq!(
                cancellable(&mut receiver, std::future::ready(7)).await,
                Some(7)
            );
            sender.send(true).unwrap();
            assert_eq!(
                cancellable(&mut receiver, std::future::ready(8)).await,
                None
            );

            let (sender, mut receiver) = tokio::sync::watch::channel(false);
            let task = tauri::async_runtime::spawn(async move {
                cancellable(&mut receiver, std::future::pending::<()>()).await
            });
            sender.send(true).unwrap();
            assert_eq!(task.await.unwrap(), None);

            let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            struct DropProbe(std::sync::Arc<std::sync::atomic::AtomicBool>);
            impl Drop for DropProbe {
                fn drop(&mut self) {
                    self.0.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
            let probe = DropProbe(dropped.clone());
            let (sender, mut receiver) = tokio::sync::watch::channel(false);
            let work = async move {
                let _probe = probe;
                std::future::poll_fn(|cx| {
                    sender.send(true).unwrap();
                    cx.waker().wake_by_ref();
                    std::task::Poll::<()>::Pending
                })
                .await;
            };
            assert_eq!(cancellable(&mut receiver, work).await, None);
            assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));

            let (sender, mut receiver) = tokio::sync::watch::channel(false);
            drop(sender);
            assert_eq!(
                cancellable(&mut receiver, std::future::pending::<()>()).await,
                None
            );
        });
    }

    #[test]
    fn native_shortcuts_dispatch_all_three_actions() {
        let settings = Settings::default();
        assert_eq!(
            shortcut_action(&settings, &shortcuts::validate(&settings.shortcut).unwrap()),
            Some(StartupAction::ToggleStt)
        );
        assert_eq!(
            shortcut_action(
                &settings,
                &shortcuts::validate(&settings.tts_shortcut).unwrap()
            ),
            Some(StartupAction::ToggleTts)
        );
        assert_eq!(
            shortcut_action(
                &settings,
                &shortcuts::validate(&settings.polish_shortcut).unwrap()
            ),
            Some(StartupAction::CyclePolish)
        );
        assert_eq!(
            shortcut_action(&settings, &shortcuts::validate("Control+Alt+9").unwrap()),
            None
        );
    }

    #[test]
    fn shortcut_edges_are_independent() {
        let mut pressed = HashSet::new();
        let stt = shortcuts::validate("Control+Super+R").unwrap();
        let tts = shortcuts::validate("Control+Super+A").unwrap();
        assert!(pressed.insert(stt));
        assert!(!pressed.insert(stt));
        assert!(pressed.insert(tts));
        assert!(!pressed.insert(tts));
        pressed.remove(&stt);
        assert!(pressed.insert(stt));
        assert!(!pressed.insert(tts));
    }

    #[test]
    fn parses_startup_actions() {
        assert_eq!(startup_action(["app"]), StartupAction::Show);
        assert_eq!(
            startup_action(["app", "--toggle"]),
            StartupAction::ToggleStt
        );
        assert_eq!(
            startup_action(["app", "--toggle-tts"]),
            StartupAction::ToggleTts
        );
        assert_eq!(
            startup_action(["app", "--cycle-polish"]),
            StartupAction::CyclePolish
        );
        assert_eq!(
            startup_action(["--toggle", "--toggle-tts"]),
            StartupAction::ToggleTts
        );
    }

    #[test]
    fn auto_paste_requires_a_shortcut_started_session() {
        let mut settings = Settings {
            auto_paste: true,
            ..Settings::default()
        };
        assert_eq!(
            ToggleOrigin::Shortcut.starts_auto_paste(&settings),
            cfg!(any(target_os = "macos", target_os = "linux"))
        );
        assert!(!ToggleOrigin::Manual.starts_auto_paste(&settings));
        settings.auto_paste = false;
        assert!(!ToggleOrigin::Shortcut.starts_auto_paste(&settings));

        assert!(ToggleOrigin::Shortcut.finishes_auto_paste());
        assert!(ToggleOrigin::Automatic.finishes_auto_paste());
        assert!(!ToggleOrigin::Manual.finishes_auto_paste());
    }
}
