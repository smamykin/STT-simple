use stt_core::PasteShortcut;

#[cfg(target_os = "macos")]
const ACCESSIBILITY_MESSAGE: &str = "Для автоматической вставки разрешите STT Simple управлять компьютером: Системные настройки → Конфиденциальность и безопасность → Универсальный доступ. Текст останется в буфере обмена.";

#[cfg(target_os = "macos")]
pub fn request_permission() -> Option<String> {
    use macos_accessibility_client::accessibility::{
        application_is_trusted, application_is_trusted_with_prompt,
    };

    if application_is_trusted() || application_is_trusted_with_prompt() {
        None
    } else {
        Some(ACCESSIBILITY_MESSAGE.into())
    }
}

#[cfg(target_os = "linux")]
pub fn request_permission() -> Option<String> {
    use std::os::unix::fs::PermissionsExt;

    let backend = LinuxBackend::current();
    let available = std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|directory| {
            std::fs::metadata(directory.join(backend.program())).is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
    });
    (!available).then(|| backend.failure())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn request_permission() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
pub async fn paste(_shortcut: PasteShortcut) -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, KeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use macos_accessibility_client::accessibility::application_is_trusted;

    if !application_is_trusted() {
        return Err(ACCESSIBILITY_MESSAGE.into());
    }

    fn keyboard_event(key_down: bool) -> Result<CGEvent, String> {
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| {
            "Не удалось подготовить автоматическую вставку. Текст остался в буфере обмена."
                .to_owned()
        })?;
        let event =
            CGEvent::new_keyboard_event(source, KeyCode::ANSI_V, key_down).map_err(|_| {
                "Не удалось создать системное нажатие Cmd+V. Текст остался в буфере обмена."
                    .to_owned()
            })?;
        event.set_flags(CGEventFlags::CGEventFlagCommand);
        Ok(event)
    }

    let key_down = keyboard_event(true)?;
    let key_up = keyboard_event(false)?;
    key_down.post(CGEventTapLocation::HID);
    key_up.post(CGEventTapLocation::HID);
    Ok(())
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum LinuxBackend {
    X11,
    Wayland,
}

#[cfg(target_os = "linux")]
impl LinuxBackend {
    fn current() -> Self {
        if crate::clipboard::is_wayland() {
            Self::Wayland
        } else {
            Self::X11
        }
    }

    fn program(self) -> &'static str {
        match self {
            Self::X11 => "xdotool",
            Self::Wayland => "ydotool",
        }
    }

    fn args(self, shortcut: PasteShortcut) -> &'static [&'static str] {
        match (self, shortcut) {
            (Self::X11, PasteShortcut::CtrlV) => &["key", "--clearmodifiers", "ctrl+v"],
            (Self::X11, PasteShortcut::CtrlShiftV) => &["key", "--clearmodifiers", "ctrl+shift+v"],
            // Linux evdev codes: LeftCtrl = 29, LeftShift = 42, V = 47.
            // Release in reverse order, and send only the chosen chord (never both).
            (Self::Wayland, PasteShortcut::CtrlV) => &["key", "29:1", "47:1", "47:0", "29:0"],
            (Self::Wayland, PasteShortcut::CtrlShiftV) => {
                &["key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"]
            }
        }
    }

    fn failure(self) -> String {
        let help = match self {
            Self::X11 => "Для автоматической вставки на X11 установите xdotool и проверьте доступ к текущей X11-сессии.",
            Self::Wayland => "Для автоматической вставки на Wayland нужен ydotool: установите современную версию (1.x), настройте ydotoold с доступом к /dev/uinput и доступ пользователя к его сокету (при необходимости задайте YDOTOOL_SOCKET перед запуском STT Simple).",
        };
        format!("{help} Текст остался в буфере обмена; его можно вставить вручную. Не запускайте STT Simple через sudo.")
    }
}

#[cfg(target_os = "linux")]
pub async fn paste(shortcut: PasteShortcut) -> Result<(), String> {
    let backend = LinuxBackend::current();
    let mut command = tokio::process::Command::new(backend.program());
    command.args(backend.args(shortcut));
    run_command(command, std::time::Duration::from_secs(5))
        .await
        .map_err(|reason| format!("{reason} {}", backend.failure()))
}

#[cfg(target_os = "linux")]
async fn run_command(
    mut command: tokio::process::Command,
    timeout: std::time::Duration,
) -> Result<(), &'static str> {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    use std::process::Stdio;

    // Never pass transcript text to a shell or helper: only synthesize a paste chord.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| "Не удалось запустить автоматическую вставку.")?;
    let process_group = child.id();
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(_)) => Err("Системная команда вставки завершилась с ошибкой."),
        failure => {
            // Kill the whole group so a stalled helper cannot paste into a later-focused field.
            if let Some(pid) = process_group {
                let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
            }
            let _ = child.start_kill();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
            if failure.is_err() {
                Err("Истекло время ожидания автоматической вставки.")
            } else {
                Err("Не удалось дождаться завершения автоматической вставки.")
            }
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::process::Command;

    #[test]
    fn linux_backends_send_only_a_paste_chord() {
        assert_eq!(LinuxBackend::X11.program(), "xdotool");
        assert_eq!(
            LinuxBackend::X11.args(PasteShortcut::CtrlV),
            &["key", "--clearmodifiers", "ctrl+v"]
        );
        assert_eq!(LinuxBackend::Wayland.program(), "ydotool");
        assert_eq!(
            LinuxBackend::Wayland.args(PasteShortcut::CtrlV),
            &["key", "29:1", "47:1", "47:0", "29:0"]
        );
    }

    #[test]
    fn shift_paste_uses_one_chord_and_releases_all_keys() {
        assert_eq!(
            LinuxBackend::X11.args(PasteShortcut::CtrlShiftV),
            &["key", "--clearmodifiers", "ctrl+shift+v"]
        );
        assert_eq!(
            LinuxBackend::Wayland.args(PasteShortcut::CtrlShiftV),
            &["key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"]
        );
    }

    #[test]
    fn helper_success_failure_and_timeout_are_reported() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut success = Command::new("/bin/sh");
            success.args(["-c", "exit 0"]);
            assert!(run_command(success, Duration::from_secs(2)).await.is_ok());

            let mut failure = Command::new("/bin/sh");
            failure.args(["-c", "exit 1"]);
            assert_eq!(
                run_command(failure, Duration::from_secs(2)).await,
                Err("Системная команда вставки завершилась с ошибкой.")
            );

            let missing = Command::new("/nonexistent/stt-simple-paste-helper");
            assert_eq!(
                run_command(missing, Duration::from_secs(2)).await,
                Err("Не удалось запустить автоматическую вставку.")
            );

            let mut stalled = Command::new("/bin/sh");
            stalled.args(["-c", "sleep 30"]);
            assert_eq!(
                run_command(stalled, Duration::from_millis(50)).await,
                Err("Истекло время ожидания автоматической вставки.")
            );
        });
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub async fn paste(_shortcut: PasteShortcut) -> Result<(), String> {
    Err(
        "Автоматическая вставка поддерживается только на macOS и Linux. Текст остался в буфере обмена."
            .into(),
    )
}
