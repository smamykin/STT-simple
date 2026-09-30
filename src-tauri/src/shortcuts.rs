use crate::{clipboard, state::Runtime};
use std::str::FromStr;
use stt_core::Settings;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub fn validate(value: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(value).map_err(|_| {
        "Некорректное сочетание клавиш. Примеры: Super+R, Control+Super+R, Control+Alt+Space."
            .into()
    })
}

pub fn wayland_message() -> String {
    let command = std::env::current_exe()
        .map(|path| {
            format!(
                "\"{}\" --toggle",
                path.to_string_lossy()
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
            )
        })
        .unwrap_or_else(|_| "stt-simple --toggle".into());
    format!("На Wayland назначьте выбранное сочетание в настройках GNOME: Клавиатура → Пользовательские комбинации. Команда: {command}. Изменение сочетания в приложении не меняет системную настройку.")
}

pub fn initialize(app: &AppHandle) {
    let runtime = app.state::<Runtime>();
    let settings = runtime.snapshot().settings;
    let (available, message) = if clipboard::is_wayland() {
        (false, Some(wayland_message()))
    } else {
        match validate(&settings.shortcut).and_then(|shortcut| {
            app.global_shortcut().register(shortcut).map_err(|_| "Не удалось зарегистрировать сочетание: оно может быть занято или запрещено системой.".to_owned())
        }) {
            Ok(()) => (true, None),
            Err(error) => (false, Some(error)),
        }
    };
    let mut data = runtime.data.lock().expect("application state poisoned");
    data.hotkey_available = available;
    data.hotkey_message = message;
}

// Register the replacement before releasing the old shortcut so conflicts do not break it.
pub fn replace(app: &AppHandle, old: &Settings, new: &Settings) -> Result<(), String> {
    let new_shortcut = validate(&new.shortcut)?;
    if clipboard::is_wayland() {
        return Ok(());
    }
    let manager = app.global_shortcut();
    let old_shortcut = validate(&old.shortcut)
        .ok()
        .filter(|shortcut| manager.is_registered(*shortcut));
    if old_shortcut == Some(new_shortcut) {
        return Ok(());
    }
    let new_was_registered = manager.is_registered(new_shortcut);
    if !new_was_registered {
        manager.register(new_shortcut).map_err(|_| {
            "Новое сочетание недоступно или занято. Выберите другое; прежние настройки сохранены.".to_owned()
        })?;
    }
    if let Some(old_shortcut) = old_shortcut {
        if manager.unregister(old_shortcut).is_err() {
            if !new_was_registered && manager.unregister(new_shortcut).is_err() {
                return Err("Не удалось удалить прежнее и новое сочетания. Перезапустите приложение для восстановления регистрации.".into());
            }
            return Err(
                "Не удалось освободить прежнее сочетание. Настройки не изменены; попробуйте снова."
                    .into(),
            );
        }
    }
    Ok(())
}
