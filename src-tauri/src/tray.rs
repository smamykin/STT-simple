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
    TrayIconBuilder::with_id("status")
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
    });
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

fn recording_action(phase: Phase, has_api_key: bool) -> (&'static str, bool) {
    match phase {
        Phase::Synthesizing | Phase::Playing => ("Остановить озвучивание и начать запись", true),
        Phase::Recording => ("Остановить и распознать", true),
        Phase::Idle => ("Начать запись", has_api_key),
        Phase::Transcribing | Phase::Polishing => ("Начать запись", false),
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
        let _ = tray.set_icon(Some(icon(snapshot.phase)));
        let _ = tray.set_tooltip(Some(format!("STT Simple — {label}")));
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
        let _ = controls
            .cancel
            .set_enabled(snapshot.phase == Phase::Recording);
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
