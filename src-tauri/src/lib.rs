mod auto_paste;
mod clipboard;
mod credentials;
#[cfg(target_os = "linux")]
mod gnome_shortcuts;
mod recorder;
mod shortcuts;
mod state;
mod tray;

use state::{Data, HotkeyMode, Phase, Runtime, Session, Snapshot};
use std::sync::Mutex;
use std::time::Duration;
use stt_core::{load_data, save_data, OpenAiClient, Settings, Statistics, StoredData};
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
        cfg!(target_os = "macos") && settings.auto_paste && self == Self::Shortcut
    }

    fn finishes_auto_paste(self) -> bool {
        matches!(self, Self::Shortcut | Self::Automatic)
    }
}

#[derive(Default)]
struct StartupQueue {
    ready: bool,
    toggles: Vec<bool>,
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

#[tauri::command]
async fn save_settings(app: AppHandle, mut settings: Settings) -> Result<Snapshot, String> {
    settings.shortcut = settings.shortcut.trim().to_owned();
    settings.validate()?;
    shortcuts::validate(&settings.shortcut)?;
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
        return Err(match rollback {
            Err(_) => format!("{error} Не удалось восстановить файл настроек; сохраните настройки повторно перед перезапуском."),
            Ok(saved) => match saved.durability_warning {
                Some(warning) => format!("{error}\n{warning}"),
                None => error,
            }
        });
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
        data.last_error = outcome.durability_warning.or(accessibility_warning);
    }
    *runtime
        .shortcut_pressed
        .lock()
        .expect("shortcut state poisoned") = false;
    tray::publish(&app);
    Ok(runtime.snapshot())
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
        data.last_error = None;
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
        data.last_error = None;
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
        data.last_error = outcome.durability_warning;
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
            let settings = runtime.snapshot().settings;
            let auto_paste = origin.starts_auto_paste(&settings);
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
                        auto_paste,
                    });
                    data.phase = Phase::Recording;
                    data.has_api_key = true;
                    data.last_error = None;
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
                auto_paste,
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
            // Finalize under the control lock: readiness, result and error are one commit.
            let _completion = runtime.control.lock().await;
            let result = match recognized {
                Ok(text) => {
                    let _clipboard = runtime.clipboard.lock().await;
                    runtime
                        .data
                        .lock()
                        .expect("application state poisoned")
                        .last_transcript = Some(text.clone());
                    clipboard::write_text(app, text).await.and_then(|()| {
                        if auto_paste && origin.finishes_auto_paste() {
                            auto_paste::paste()
                        } else {
                            Ok(())
                        }
                    })
                }
                Err(error) => Err(error),
            };
            commit_idle(app, result.as_ref().err().cloned());
            result
        }
        Phase::Transcribing | Phase::Polishing => Ok(()),
    }
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
        if snapshot.phase == Phase::Idle && snapshot.last_error.is_some() {
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
        let session = runtime
            .data
            .lock()
            .expect("application state poisoned")
            .session
            .take();
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

fn dispatch_request(app: &AppHandle, toggle: bool) {
    if toggle {
        spawn_shortcut_toggle(app.clone());
    } else {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || tray::show_window(&handle));
    }
}

pub fn run() {
    let wayland = clipboard::is_wayland();
    let mut builder = tauri::Builder::default()
        .manage(StartupRequests::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let toggle = args.iter().any(|arg| arg == "--toggle");
            let requests = app.state::<StartupRequests>();
            let mut queue = requests.queue.lock().expect("startup queue poisoned");
            if !queue.ready {
                queue.toggles.push(toggle);
                return;
            }
            drop(queue);
            dispatch_request(app, toggle);
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
                    let active = shortcuts::validate(&runtime.snapshot().settings.shortcut).ok();
                    if active.as_ref() != Some(shortcut) {
                        return;
                    }
                    let mut pressed = runtime
                        .shortcut_pressed
                        .lock()
                        .expect("shortcut state poisoned");
                    match event.state() {
                        ShortcutState::Pressed if !*pressed => {
                            *pressed = true;
                            spawn_shortcut_toggle(app.clone());
                        }
                        ShortcutState::Released => {
                            *pressed = false;
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
                data: Mutex::new(Data { stored, phase: Phase::Idle, session: None, next_session_id: 0,
                    last_transcript: None, last_error, has_api_key,
                    hotkey_available: false, hotkey_message: None,
                    hotkey_mode: if wayland { HotkeyMode::System } else { HotkeyMode::Native },
                    hotkey_command: if wayland { Some(shortcuts::wayland_command()) } else { None } }),
                control: tokio::sync::Mutex::new(()),
                clipboard: tokio::sync::Mutex::new(()),
                shortcut_pressed: Mutex::new(false),
                client, storage_path,
            });
            if tray::initialize(&handle).is_err() {
                handle.state::<Runtime>().data.lock().expect("application state poisoned").last_error = Some("Не удалось создать индикатор трея. Проверьте поддержку AppIndicator в GNOME; окно приложения оставлено открытым.".into());
            }
            shortcuts::initialize(&handle);
            tray::publish(&handle);
            monitor_microphone(handle.clone());
            dispatch_request(&handle, std::env::args().any(|arg| arg == "--toggle"));
            if handle.tray_by_id("status").is_none() { tray::show_window(&handle); }
            let requests = handle.state::<StartupRequests>();
            let pending = {
                let mut queue = requests.queue.lock().expect("startup queue poisoned");
                queue.ready = true;
                std::mem::take(&mut queue.toggles)
            };
            for toggle in pending { dispatch_request(&handle, toggle); }
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
        .invoke_handler(tauri::generate_handler![get_snapshot, list_input_devices,
            save_settings, set_api_key, delete_api_key, reset_statistics,
            toggle_recording, cancel_recording, copy_last_transcript, quit_app])
        .run(tauri::generate_context!())
        .expect("failed to run STT Simple");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_paste_requires_a_shortcut_started_session() {
        let mut settings = Settings {
            auto_paste: true,
            ..Settings::default()
        };
        assert_eq!(
            ToggleOrigin::Shortcut.starts_auto_paste(&settings),
            cfg!(target_os = "macos")
        );
        assert!(!ToggleOrigin::Manual.starts_auto_paste(&settings));
        settings.auto_paste = false;
        assert!(!ToggleOrigin::Shortcut.starts_auto_paste(&settings));

        assert!(ToggleOrigin::Shortcut.finishes_auto_paste());
        assert!(ToggleOrigin::Automatic.finishes_auto_paste());
        assert!(!ToggleOrigin::Manual.finishes_auto_paste());
    }
}
