use crate::state::{Phase, Runtime, Snapshot};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

pub struct Controls {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    speech: MenuItem<Wry>,
    cancel: MenuItem<Wry>,
    copy: MenuItem<Wry>,
    #[cfg(target_os = "linux")]
    icon_phase: std::sync::Mutex<Phase>,
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn initialize(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Готово к записи", false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Начать запись", true, None::<&str>)?;
    let speech = MenuItem::with_id(app, "speech", "Озвучить буфер", false, None::<&str>)?;
    let cancel = MenuItem::with_id(app, "cancel", "Отменить запись", false, None::<&str>)?;
    let copy = MenuItem::with_id(
        app,
        "copy",
        "Скопировать последний результат",
        false,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "settings", "Открыть приложение", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&status, &toggle, &speech, &cancel, &copy, &settings, &quit],
    )?;
    let builder = TrayIconBuilder::with_id("status");
    #[cfg(target_os = "linux")]
    let builder = builder.temp_dir_path(create_icon_dir()?);
    #[cfg(target_os = "macos")]
    let builder = builder.title("Off");
    builder
        .icon(icon(Phase::Idle))
        .icon_as_template(false)
        .tooltip("STT Simple — готово к записи")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => show_window(app),
            "toggle" => crate::spawn_toggle(app.clone()),
            "speech" => crate::spawn_speech(app.clone()),
            "cancel" => crate::spawn_cancel(app.clone()),
            "copy" => crate::spawn_copy(app.clone()),
            "quit" => crate::shutdown(app),
            _ => {}
        })
        .build(app)?;
    app.manage(Controls {
        status,
        toggle,
        speech,
        cancel,
        copy,
        #[cfg(target_os = "linux")]
        icon_phase: std::sync::Mutex::new(Phase::Idle),
    });
    Ok(())
}

#[cfg(target_os = "linux")]
fn create_icon_dir() -> std::io::Result<std::path::PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // The backend resets its filename counter on launch; never reuse a host cache key.
    for attempt in 0..16 {
        let path = std::env::temp_dir().join(format!(
            "stt-simple-tray-{}-{nanos}-{attempt}",
            std::process::id()
        ));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not create a unique tray icon directory",
    ))
}

#[cfg(target_os = "linux")]
fn update_icon_phase<E>(
    last_phase: &mut Phase,
    phase: Phase,
    set_icon: impl FnOnce() -> Result<(), E>,
) -> Result<(), E> {
    if *last_phase != phase {
        set_icon()?;
        *last_phase = phase;
    }
    Ok(())
}

pub fn publish(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        // Read at delivery time: queued notifications must not publish obsolete states.
        let snapshot = handle.state::<Runtime>().snapshot();
        let _ = handle.emit("app-state", &snapshot);
        refresh(&handle, &snapshot);
    });
}

fn selected_profile_name(polish: &stt_core::PolishSettings) -> Option<String> {
    let selected = polish.profile_id.as_deref()?;
    stt_core::builtin_polish_profiles()
        .into_iter()
        .chain(polish.custom_profiles.iter().cloned())
        .find(|profile| profile.id == selected)
        .map(|profile| profile.name)
}

fn mode_title(polish: &stt_core::PolishSettings) -> String {
    match polish.profile_id.as_deref() {
        None => "Off".into(),
        Some("polish") => "Fix".into(),
        Some("markdown") => "MD".into(),
        Some("developer") => "Dev".into(),
        Some(_) => selected_profile_name(polish)
            .map(|name| {
                let mut chars = name.chars();
                let prefix: String = chars.by_ref().take(11).collect();
                if chars.next().is_some() {
                    format!("{prefix}…")
                } else {
                    prefix
                }
            })
            .unwrap_or_else(|| "Off".into()),
    }
}

fn recording_action(phase: Phase, has_api_key: bool) -> (&'static str, bool) {
    match phase {
        Phase::Synthesizing | Phase::Playing => ("Остановить озвучивание и начать запись", true),
        Phase::Recording => ("Остановить и распознать", true),
        Phase::Idle => ("Начать запись", has_api_key),
        Phase::Transcribing | Phase::Polishing => ("Начать запись", false),
    }
}

fn cancellation_action(phase: Phase) -> (&'static str, bool) {
    match phase {
        Phase::Recording => ("Отменить запись", true),
        Phase::Transcribing => ("Отменить распознавание", true),
        Phase::Polishing => ("Отменить обработку и оставить исходный текст", true),
        _ => ("Отменить запись", false),
    }
}

fn refresh(app: &AppHandle, snapshot: &Snapshot) {
    let label = match snapshot.phase {
        Phase::Idle => "Готово к записи",
        Phase::Recording => "Идет запись",
        Phase::Transcribing => "Распознавание речи",
        Phase::Polishing => "Обработка текста",
        Phase::Synthesizing => "Создание речи",
        Phase::Playing => "Воспроизведение",
    };
    if let Some(tray) = app.tray_by_id("status") {
        #[cfg(target_os = "linux")]
        if let Some(controls) = app.try_state::<Controls>() {
            let mut last_phase = controls
                .icon_phase
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let _ = update_icon_phase(&mut last_phase, snapshot.phase, || {
                tray.set_icon(Some(icon(snapshot.phase)))
            });
        }
        #[cfg(not(target_os = "linux"))]
        let _ = tray.set_icon(Some(icon(snapshot.phase)));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(Some(mode_title(&snapshot.settings.polish)));
        let profile =
            selected_profile_name(&snapshot.settings.polish).unwrap_or_else(|| "Выключено".into());
        let _ = tray.set_tooltip(Some(format!("STT Simple — {label} — обработка: {profile}")));
    }
    if let Some(controls) = app.try_state::<Controls>() {
        let speaking = matches!(snapshot.phase, Phase::Synthesizing | Phase::Playing);
        let _ = controls.speech.set_text(if speaking {
            "Остановить озвучивание"
        } else {
            "Озвучить буфер"
        });
        let _ = controls
            .speech
            .set_enabled(speaking || (snapshot.phase == Phase::Idle && snapshot.has_api_key));
        let _ = controls.status.set_text(if snapshot.last_error.is_some() {
            "Ошибка — откройте приложение"
        } else {
            label
        });
        let (recording_label, recording_enabled) =
            recording_action(snapshot.phase, snapshot.has_api_key);
        let _ = controls.toggle.set_text(recording_label);
        let _ = controls.toggle.set_enabled(recording_enabled);
        let (cancel_label, cancel_enabled) = cancellation_action(snapshot.phase);
        let _ = controls.cancel.set_text(cancel_label);
        let _ = controls.cancel.set_enabled(cancel_enabled);
        let _ = controls
            .copy
            .set_enabled(snapshot.phase == Phase::Idle && snapshot.last_transcript.is_some());
    }
}

pub fn icon(phase: Phase) -> Image<'static> {
    Image::new_owned(icon_pixels(phase), 32, 32)
}

fn icon_pixels(phase: Phase) -> Vec<u8> {
    let color = match phase {
        Phase::Idle => [226, 71, 82, 255],
        Phase::Recording => [50, 200, 120, 255],
        Phase::Transcribing => [60, 140, 245, 255],
        Phase::Polishing | Phase::Synthesizing => [245, 197, 60, 255],
        Phase::Playing => [170, 95, 230, 255],
    };
    let mut pixels = vec![0; 32 * 32 * 4];
    for y in 0..32_i32 {
        for x in 0..32_i32 {
            let distance = (x * 2 - 31).pow(2) + (y * 2 - 31).pow(2);
            let offset = ((y * 32 + x) * 4) as usize;
            if distance <= 28 * 28 {
                pixels[offset..offset + 4].copy_from_slice(&color);
            }
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn icon_directories_are_unique() {
        let first = create_icon_dir().unwrap();
        let second = create_icon_dir().unwrap();
        assert_ne!(first, second);
        assert!(first.is_dir());
        assert!(second.is_dir());
        std::fs::remove_dir(first).unwrap();
        std::fs::remove_dir(second).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn icon_updates_skip_initial_idle_and_duplicate_phases() {
        let mut last_phase = Phase::Idle;
        let mut updates = 0;
        for phase in [
            Phase::Idle,
            Phase::Recording,
            Phase::Recording,
            Phase::Idle,
            Phase::Idle,
        ] {
            update_icon_phase(&mut last_phase, phase, || {
                updates += 1;
                Ok::<_, ()>(())
            })
            .unwrap();
        }
        assert_eq!(updates, 2);
        assert!(last_phase == Phase::Idle);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn failed_icon_update_is_retried() {
        let mut last_phase = Phase::Idle;
        assert!(update_icon_phase(&mut last_phase, Phase::Recording, || Err(())).is_err());
        assert!(last_phase == Phase::Idle);
        let mut retried = false;
        update_icon_phase(&mut last_phase, Phase::Recording, || {
            retried = true;
            Ok::<_, ()>(())
        })
        .unwrap();
        assert!(retried);
        assert!(last_phase == Phase::Recording);
    }

    #[test]
    fn tray_mode_labels_are_compact_and_safe() {
        let mut polish = stt_core::PolishSettings::default();
        assert_eq!(mode_title(&polish), "Off");
        for (id, expected) in [("polish", "Fix"), ("markdown", "MD"), ("developer", "Dev")] {
            polish.profile_id = Some(id.into());
            assert_eq!(mode_title(&polish), expected);
        }
        polish.custom_profiles.push(stt_core::PolishProfile {
            id: "custom-long".into(),
            name: "Очень длинный профиль".into(),
            instruction: "Test".into(),
        });
        polish.profile_id = Some("custom-long".into());
        assert_eq!(mode_title(&polish), "Очень длинн…");
        assert!(mode_title(&polish).chars().count() <= 12);
        polish.profile_id = Some("missing".into());
        assert_eq!(mode_title(&polish), "Off");
    }

    #[test]
    fn tray_stt_action_can_interrupt_speech_but_not_transcription() {
        for phase in [Phase::Synthesizing, Phase::Playing] {
            let (label, enabled) = recording_action(phase, false);
            assert!(enabled);
            assert_eq!(label, "Остановить озвучивание и начать запись");
        }
        assert!(recording_action(Phase::Recording, false).1);
        assert!(recording_action(Phase::Idle, true).1);
        assert!(!recording_action(Phase::Idle, false).1);
        for phase in [Phase::Transcribing, Phase::Polishing] {
            assert!(!recording_action(phase, true).1);
        }
    }

    #[test]
    fn tray_cancellation_is_available_throughout_dictation() {
        for phase in [Phase::Recording, Phase::Transcribing, Phase::Polishing] {
            assert!(cancellation_action(phase).1);
        }
        for phase in [Phase::Idle, Phase::Synthesizing, Phase::Playing] {
            assert!(!cancellation_action(phase).1);
        }
        assert!(cancellation_action(Phase::Polishing)
            .0
            .contains("исходный текст"));
    }

    #[test]
    fn tray_colors_match_requested_states() {
        let center = (16 * 32 + 16) * 4;
        for (phase, expected) in [
            (Phase::Idle, [226, 71, 82, 255]),
            (Phase::Recording, [50, 200, 120, 255]),
            (Phase::Transcribing, [60, 140, 245, 255]),
            (Phase::Polishing, [245, 197, 60, 255]),
            (Phase::Synthesizing, [245, 197, 60, 255]),
            (Phase::Playing, [170, 95, 230, 255]),
        ] {
            let pixels = icon_pixels(phase);
            assert_eq!(&pixels[center..center + 4], &expected);
            assert_eq!(&pixels[0..4], &[0, 0, 0, 0]);
        }
    }
}
