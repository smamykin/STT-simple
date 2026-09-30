#[cfg(target_os = "linux")]
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

pub fn is_wayland() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland"))
}

pub async fn write_text(app: &AppHandle, text: String) -> Result<(), String> {
    if is_wayland() {
        return wayland_copy(text).await;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || handle.clipboard().write_text(text))
        .await
        .map_err(|_| "Копирование завершилось неожиданно.".to_owned())?
        .map_err(|_| {
            "Не удалось записать текст в буфер обмена. Результат доступен в окне приложения.".into()
        })
}

#[cfg(target_os = "linux")]
async fn wayland_copy(text: String) -> Result<(), String> {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;
    let mut command = Command::new("wl-copy");
    command
        .args(["--type", "text/plain;charset=utf-8"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
    let mut child = command.spawn().map_err(|_| "Для буфера обмена на Wayland нужен wl-copy. Установите пакет wl-clipboard; результат доступен в окне приложения.".to_owned())?;
    let process_group = child.id();
    // GNOME 42 may wait for a temporary selection surface to receive focus. Bound both
    // stdin transfer and that wait; abandoning a blocking task could cause a late overwrite.
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let mut stdin = child.stdin.take().ok_or_else(|| "Не удалось открыть буфер обмена.".to_owned())?;
        stdin.write_all(text.as_bytes()).await.map_err(|_| "Не удалось передать текст в буфер обмена.".to_owned())?;
        drop(stdin);
        let status = child.wait().await.map_err(|_| "Не удалось завершить копирование текста.".to_owned())?;
        if status.success() { Ok(()) }
        else { Err("Wayland не разрешил копирование. Результат доступен в окне приложения; проверьте wl-clipboard и активную сессию.".into()) }
    }).await;
    match result {
        Ok(Ok(())) => Ok(()),
        failure => {
            if let Some(pid) = process_group {
                let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
            }
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            match failure {
                Ok(Err(error)) => Err(error),
                _ => Err("Копирование на Wayland не завершилось вовремя. Результат сохранен в окне приложения; попробуйте скопировать его снова.".into()),
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
async fn wayland_copy(_text: String) -> Result<(), String> {
    Err("Буфер Wayland недоступен на этой платформе.".into())
}
