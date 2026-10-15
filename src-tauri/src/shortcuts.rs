use crate::{clipboard, state::Runtime};
use std::collections::HashSet;
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

pub fn wayland_command() -> String {
    std::env::current_exe()
        .map(|path| {
            format!(
                "\"{}\" --toggle",
                path.to_string_lossy()
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
            )
        })
        .unwrap_or_else(|_| "stt-simple --toggle".into())
}

fn verify_system(shortcut: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        crate::gnome_shortcuts::verify(shortcut, &wayland_command())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = shortcut;
        Err("Автоматическая настройка GNOME поддерживается только на Linux.".into())
    }
}

pub fn validate_all(settings: &Settings) -> Result<[Shortcut; 4], String> {
    let primary = validate_primary(settings)?;
    let cancel = validate(&settings.cancel_shortcut)?;
    if primary.contains(&cancel) {
        return Err("Сочетание клавиш отмены не должно совпадать с другими сочетаниями.".into());
    }
    Ok([primary[0], primary[1], primary[2], cancel])
}

fn validate_primary(settings: &Settings) -> Result<[Shortcut; 3], String> {
    let shortcuts = [
        validate(&settings.shortcut)?,
        validate(&settings.tts_shortcut)?,
        validate(&settings.polish_shortcut)?,
    ];
    if shortcuts[0] == shortcuts[1] || shortcuts[0] == shortcuts[2] || shortcuts[1] == shortcuts[2]
    {
        return Err(
            "Сочетания клавиш распознавания, озвучивания и обработки не должны совпадать.".into(),
        );
    }
    Ok(shortcuts)
}

pub fn wayland_tts_command() -> String {
    wayland_command()
        .strip_suffix(" --toggle")
        .map(|exe| format!("{exe} --toggle-tts"))
        .unwrap_or_else(|| "stt-simple --toggle-tts".into())
}

pub fn wayland_polish_command() -> String {
    wayland_command()
        .strip_suffix(" --toggle")
        .map(|exe| format!("{exe} --cycle-polish"))
        .unwrap_or_else(|| "stt-simple --cycle-polish".into())
}

pub fn wayland_cancel_command() -> String {
    wayland_command()
        .strip_suffix(" --toggle")
        .map(|exe| format!("{exe} --cancel"))
        .unwrap_or_else(|| "stt-simple --cancel".into())
}

fn verify_system_polish(shortcut: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        crate::gnome_shortcuts::verify_polish(shortcut, &wayland_polish_command())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = shortcut;
        Err("Автоматическая настройка GNOME поддерживается только на Linux.".into())
    }
}

pub fn update_tts_status(app: &AppHandle) {
    let runtime = app.state::<Runtime>();
    let polish_status = if clipboard::is_wayland() {
        verify_system_polish(&runtime.snapshot().settings.polish_shortcut)
    } else {
        Ok(())
    };
    let mut data = runtime.data.lock().expect("application state poisoned");
    if clipboard::is_wayland() {
        data.cancel_hotkey_available = false;
        data.cancel_hotkey_command = Some(wayland_cancel_command());
        data.cancel_hotkey_message =
            Some("Назначьте команду отмены вручную в системных сочетаниях клавиш.".into());
        data.tts_hotkey_available = false;
        data.tts_hotkey_command = Some(wayland_tts_command());
        data.tts_hotkey_message = Some("Назначьте команду озвучивания вручную в системных сочетаниях клавиш. TTS на Linux не проверен.".into());
        data.polish_hotkey_available = polish_status.is_ok();
        data.polish_hotkey_command = Some(wayland_polish_command());
        data.polish_hotkey_message = polish_status.err();
    } else {
        data.cancel_hotkey_available = true;
        data.cancel_hotkey_command = None;
        data.cancel_hotkey_message = None;
        data.tts_hotkey_available = true;
        data.tts_hotkey_command = None;
        data.tts_hotkey_message = None;
        data.polish_hotkey_available = true;
        data.polish_hotkey_command = None;
        data.polish_hotkey_message = None;
    }
}

pub fn retain_pressed(pressed: &mut HashSet<Shortcut>, shortcuts: &[Shortcut]) {
    pressed.retain(|shortcut| shortcuts.contains(shortcut));
}

trait Registrations {
    fn contains(&self, shortcut: Shortcut) -> bool;
    fn register(&self, shortcut: Shortcut) -> Result<(), ()>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), ()>;
}

struct NativeRegistrations<'a>(&'a AppHandle);
impl Registrations for NativeRegistrations<'_> {
    fn contains(&self, shortcut: Shortcut) -> bool {
        self.0.global_shortcut().is_registered(shortcut)
    }
    fn register(&self, shortcut: Shortcut) -> Result<(), ()> {
        self.0.global_shortcut().register(shortcut).map_err(|_| ())
    }
    fn unregister(&self, shortcut: Shortcut) -> Result<(), ()> {
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|_| ())
    }
}

fn registration_error(message: &str, degraded: bool) -> String {
    if degraded {
        format!("{message} Откат регистрации не завершён; сочетания могут работать некорректно. После успешного сохранения настроек перезапустите приложение для восстановления регистрации.")
    } else {
        message.into()
    }
}

// The same transaction is used for initialization and replacement; swaps acquire nothing.
fn replace_native(
    manager: &impl Registrations,
    old: &[Shortcut],
    new: &[Shortcut],
) -> Result<(), String> {
    let mut added = Vec::new();
    for &shortcut in new {
        if !manager.contains(shortcut) {
            if manager.register(shortcut).is_err() {
                let mut degraded = false;
                for &added in added.iter().rev() {
                    degraded |= manager.unregister(added).is_err();
                }
                return Err(registration_error(
                    "Новое сочетание недоступно или занято. Прежние настройки сохранены.",
                    degraded,
                ));
            }
            added.push(shortcut);
        }
    }
    let mut removed = Vec::new();
    for &shortcut in old {
        if !new.contains(&shortcut) && manager.contains(shortcut) {
            if manager.unregister(shortcut).is_err() {
                let mut degraded = false;
                for removed in removed {
                    degraded |= manager.register(removed).is_err();
                }
                for &added in added.iter().rev() {
                    degraded |= manager.unregister(added).is_err();
                }
                return Err(registration_error(
                    "Не удалось освободить прежнее сочетание. Настройки не изменены.",
                    degraded,
                ));
            }
            removed.push(shortcut);
        }
    }
    Ok(())
}

fn initialize_native(manager: &impl Registrations, settings: &Settings) -> [Result<(), String>; 4] {
    let primary =
        validate_primary(settings).and_then(|shortcuts| replace_native(manager, &[], &shortcuts));
    let cancel = validate(&settings.cancel_shortcut).and_then(|cancel| {
        let conflicts = [&settings.shortcut, &settings.tts_shortcut, &settings.polish_shortcut]
            .iter().filter_map(|value| validate(value).ok()).any(|shortcut| shortcut == cancel);
        if conflicts {
            return Err("Сочетание клавиш отмены не должно совпадать с другими сочетаниями.".into());
        }
        replace_native(manager, &[], &[cancel])
            .map_err(|_| "Не удалось зарегистрировать сочетание отмены: оно недоступно или занято. Выберите другое в настройках; отмена через трей доступна.".into())
    });
    [primary.clone(), primary.clone(), primary, cancel]
}

pub fn initialize(app: &AppHandle) {
    let runtime = app.state::<Runtime>();
    let settings = runtime.snapshot().settings;
    update_tts_status(app);
    let results = if clipboard::is_wayland() {
        [verify_system(&settings.shortcut), Ok(()), Ok(()), Ok(())]
    } else {
        initialize_native(&NativeRegistrations(app), &settings)
    };
    let mut data = runtime.data.lock().expect("application state poisoned");
    data.hotkey_available = results[0].is_ok();
    data.hotkey_message = results[0].as_ref().err().cloned();
    if !clipboard::is_wayland() {
        data.cancel_hotkey_available = results[3].is_ok();
        data.cancel_hotkey_message = results[3].as_ref().err().cloned();
        data.tts_hotkey_available = results[1].is_ok();
        data.tts_hotkey_message = results[1].as_ref().err().cloned();
        data.polish_hotkey_available = results[2].is_ok();
        data.polish_hotkey_command = None;
        data.polish_hotkey_message = results[2].as_ref().err().cloned();
    }
}

// Acquire the entire new pair before releasing any old registration, including swaps.
pub async fn replace(app: &AppHandle, old: &Settings, new: &Settings) -> Result<(), String> {
    let new_shortcuts = validate_all(new)?;
    if clipboard::is_wayland() {
        #[cfg(target_os = "linux")]
        {
            let shortcut = new.shortcut.clone();
            let command = wayland_command();
            let polish_shortcut = new.polish_shortcut.clone();
            let polish_command = wayland_polish_command();
            return crate::blocking(move || {
                crate::gnome_shortcuts::apply_recording_and_polish(
                    &shortcut,
                    &command,
                    &polish_shortcut,
                    &polish_command,
                )
            })
            .await;
        }
        #[cfg(not(target_os = "linux"))]
        return Err("Автоматическая настройка GNOME поддерживается только на Linux.".into());
    }
    let old_shortcuts: Vec<_> = [
        &old.shortcut,
        &old.tts_shortcut,
        &old.polish_shortcut,
        &old.cancel_shortcut,
    ]
    .into_iter()
    .filter_map(|value| validate(value).ok())
    .collect();
    replace_native(&NativeRegistrations(app), &old_shortcuts, &new_shortcuts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeRegistrations {
        held: RefCell<HashSet<Shortcut>>,
        failures: RefCell<Vec<(bool, Shortcut)>>,
        calls: RefCell<Vec<(bool, Shortcut)>>,
    }
    impl Registrations for FakeRegistrations {
        fn contains(&self, shortcut: Shortcut) -> bool {
            self.held.borrow().contains(&shortcut)
        }
        fn register(&self, shortcut: Shortcut) -> Result<(), ()> {
            self.apply(true, shortcut)
        }
        fn unregister(&self, shortcut: Shortcut) -> Result<(), ()> {
            self.apply(false, shortcut)
        }
    }
    impl FakeRegistrations {
        fn apply(&self, register: bool, shortcut: Shortcut) -> Result<(), ()> {
            let call = (register, shortcut);
            self.calls.borrow_mut().push(call);
            let mut failures = self.failures.borrow_mut();
            if failures.first() == Some(&call) {
                failures.remove(0);
                return Err(());
            }
            if register {
                self.held.borrow_mut().insert(shortcut);
            } else {
                self.held.borrow_mut().remove(&shortcut);
            }
            Ok(())
        }
    }
    fn pair(a: &str, b: &str) -> [Shortcut; 2] {
        [validate(a).unwrap(), validate(b).unwrap()]
    }

    fn shortcuts(a: &str, b: &str, c: &str) -> [Shortcut; 3] {
        [
            validate(a).unwrap(),
            validate(b).unwrap(),
            validate(c).unwrap(),
        ]
    }

    #[test]
    fn cancellation_startup_failure_does_not_disable_other_shortcuts() {
        let settings = Settings::default();
        let all = validate_all(&settings).unwrap();
        let manager = FakeRegistrations::default();
        manager.failures.borrow_mut().push((true, all[3]));
        let results = initialize_native(&manager, &settings);
        assert!(results[..3].iter().all(Result::is_ok));
        assert!(results[3].as_ref().unwrap_err().contains("отмены"));
        assert!(all[..3].iter().all(|shortcut| manager.contains(*shortcut)));
        assert!(!manager.contains(all[3]));
    }

    #[test]
    fn cancellation_still_registers_when_a_primary_shortcut_is_unavailable() {
        let settings = Settings::default();
        let all = validate_all(&settings).unwrap();
        let manager = FakeRegistrations::default();
        manager.failures.borrow_mut().push((true, all[1]));
        let results = initialize_native(&manager, &settings);
        assert!(results[..3].iter().all(Result::is_err));
        assert!(results[3].is_ok());
        assert_eq!(*manager.held.borrow(), HashSet::from([all[3]]));
    }

    #[test]
    fn invalid_cancellation_binding_does_not_affect_primary_registration() {
        for value in ["Not+A+Shortcut", "Control+Super+A"] {
            let settings = Settings {
                cancel_shortcut: value.into(),
                ..Settings::default()
            };
            let manager = FakeRegistrations::default();
            let results = initialize_native(&manager, &settings);
            assert!(results[..3].iter().all(Result::is_ok));
            assert!(results[3].is_err());
            assert_eq!(manager.held.borrow().len(), 3);
        }
    }

    #[test]
    fn cancellation_is_parsed_validated_and_replaced_transactionally() {
        let settings = Settings::default();
        let old = validate_all(&settings).unwrap();
        assert_eq!(old[3], validate("ctrl+shift+esc").unwrap());
        for conflict in [
            &settings.shortcut,
            &settings.tts_shortcut,
            &settings.polish_shortcut,
        ] {
            assert!(validate_all(&Settings {
                cancel_shortcut: conflict.clone(),
                ..settings.clone()
            })
            .is_err());
        }
        let mut new = old;
        new[3] = validate("Control+Alt+Escape").unwrap();
        let manager = FakeRegistrations::default();
        initialize_native(&manager, &settings)
            .into_iter()
            .for_each(|result| result.unwrap());
        manager.failures.borrow_mut().push((true, new[3]));
        assert!(replace_native(&manager, &old, &new).is_err());
        assert_eq!(*manager.held.borrow(), HashSet::from(old));
        replace_native(&manager, &old, &new).unwrap();
        assert_eq!(*manager.held.borrow(), HashSet::from(new));
        let mut pressed = HashSet::from(old);
        retain_pressed(&mut pressed, &old);
        assert!(!pressed.insert(old[3]));
        pressed.remove(&old[3]);
        assert!(pressed.insert(old[3]));
        retain_pressed(&mut pressed, &new);
        assert!(!pressed.contains(&old[3]));
    }

    #[test]
    fn initial_registration_failure_rolls_back_only_acquired_shortcuts() {
        let new = shortcuts("Control+Super+A", "Control+Super+B", "Control+Super+C");
        let manager = FakeRegistrations::default();
        manager.failures.borrow_mut().push((true, new[2]));
        assert!(replace_native(&manager, &[], &new).is_err());
        assert!(manager.held.borrow().is_empty());
        assert_eq!(
            *manager.calls.borrow(),
            vec![
                (true, new[0]),
                (true, new[1]),
                (true, new[2]),
                (false, new[1]),
                (false, new[0]),
            ]
        );
        manager.held.borrow_mut().extend([new[0], new[1]]);
        manager.calls.borrow_mut().clear();
        manager.failures.borrow_mut().push((true, new[2]));
        assert!(replace_native(&manager, &[], &new).is_err());
        assert!(manager.contains(new[0]));
        assert!(manager.contains(new[1]));
        assert_eq!(*manager.calls.borrow(), vec![(true, new[2])]);
    }

    #[test]
    fn registration_failure_reports_cleanup_failure_without_releasing_old_pair() {
        let old = pair("Control+Super+R", "Control+Super+T");
        let new = pair("Control+Super+A", "Control+Super+B");
        let manager = FakeRegistrations::default();
        manager.held.borrow_mut().extend(old);
        manager
            .failures
            .borrow_mut()
            .extend([(true, new[1]), (false, new[0])]);
        let error = replace_native(&manager, &old, &new).unwrap_err();
        assert!(error.contains("Откат регистрации не завершён"));
        assert!(error.contains("перезапустите"));
        assert!(old.iter().all(|shortcut| manager.contains(*shortcut)));
    }

    #[test]
    fn initial_pair_cleanup_failure_reports_degraded() {
        let new = pair("Control+Super+A", "Control+Super+B");
        let manager = FakeRegistrations::default();
        manager
            .failures
            .borrow_mut()
            .extend([(true, new[1]), (false, new[0])]);
        assert!(replace_native(&manager, &[], &new)
            .unwrap_err()
            .contains("Откат регистрации не завершён"));
    }

    #[test]
    fn replacements_acquire_before_release_and_swaps_do_not_reregister() {
        let old = pair("Control+Super+R", "Control+Super+T");
        let new = pair("Control+Super+A", "Control+Super+B");
        let manager = FakeRegistrations::default();
        manager.held.borrow_mut().extend(old);
        replace_native(&manager, &old, &new).unwrap();
        assert_eq!(
            *manager.calls.borrow(),
            vec![
                (true, new[0]),
                (true, new[1]),
                (false, old[0]),
                (false, old[1])
            ]
        );
        manager.calls.borrow_mut().clear();
        replace_native(&manager, &new, &[new[1], new[0]]).unwrap();
        assert!(manager.calls.borrow().is_empty());
    }

    #[test]
    fn release_failure_restores_removed_old_and_cleans_new_pair() {
        let old = pair("Control+Super+R", "Control+Super+T");
        let new = pair("Control+Super+A", "Control+Super+B");
        let manager = FakeRegistrations::default();
        manager.held.borrow_mut().extend(old);
        manager.failures.borrow_mut().push((false, old[1]));
        assert!(replace_native(&manager, &old, &new).is_err());
        assert_eq!(*manager.held.borrow(), HashSet::from(old));
    }

    #[test]
    fn release_rollback_checks_all_restoration_and_cleanup_errors() {
        let old = pair("Control+Super+R", "Control+Super+T");
        let new = pair("Control+Super+A", "Control+Super+B");
        let manager = FakeRegistrations::default();
        manager.held.borrow_mut().extend(old);
        manager
            .failures
            .borrow_mut()
            .extend([(false, old[1]), (true, old[0]), (false, new[1])]);
        assert!(replace_native(&manager, &old, &new)
            .unwrap_err()
            .contains("Откат регистрации не завершён"));
        assert_eq!(manager.calls.borrow().last(), Some(&(false, new[0])));
        assert!(manager.failures.borrow().is_empty());
    }

    #[test]
    fn settings_save_retains_held_edges_for_unchanged_and_swapped_shortcuts() {
        let old = shortcuts("Control+Super+R", "Control+Super+A", "Control+Super+P");
        let mut pressed = HashSet::from(old);
        retain_pressed(&mut pressed, &[old[2], old[1], old[0]]);
        assert_eq!(pressed.len(), 3);
        let new = shortcuts("Control+Super+R", "Control+Super+B", "Control+Super+P");
        retain_pressed(&mut pressed, &new);
        assert_eq!(pressed, HashSet::from([old[0], old[2]]));
        assert!(!pressed.insert(old[0]));
        assert!(!pressed.insert(old[2]));
        assert!(pressed.insert(new[1]));
    }

    #[test]
    fn parses_tts_and_rejects_equivalent_shortcuts() {
        assert!(validate("Control+Super+A").is_ok());
        let mut settings = Settings::default();
        settings.shortcut = "Super+Control+A".into();
        assert!(validate_all(&settings).is_err());
        settings.shortcut = Settings::default().shortcut;
        settings.polish_shortcut = settings.shortcut.clone();
        assert!(validate_all(&settings).is_err());
        settings.polish_shortcut = settings.tts_shortcut.clone();
        assert!(validate_all(&settings).is_err());
    }
    #[test]
    fn explicitly_persisted_cycle_conflicts_reach_backend_validation() {
        for candidate in [
            "Control+Super+Backslash",
            "Control+Super+5",
            "Control+Super+6",
        ] {
            assert!(validate(candidate).is_ok());
        }
        for (stt, tts) in [
            ("Control+Super+Backslash", "Control+Super+A"),
            ("Control+Super+R", "cMd+cTrL+Backslash"),
        ] {
            let settings = Settings {
                shortcut: stt.into(),
                tts_shortcut: tts.into(),
                polish_shortcut: "Super+Control+Backslash".into(),
                ..Settings::default()
            };
            assert_eq!(settings.polish_shortcut, "Super+Control+Backslash");
            assert!(validate_all(&settings)
                .unwrap_err()
                .contains("не должны совпадать"));
        }
    }

    #[test]
    fn wayland_commands_use_distinct_actions() {
        assert!(wayland_command().ends_with(" --toggle"));
        assert!(wayland_tts_command().ends_with(" --toggle-tts"));
        assert!(wayland_polish_command().ends_with(" --cycle-polish"));
        assert!(wayland_cancel_command().ends_with(" --cancel"));
    }
}
