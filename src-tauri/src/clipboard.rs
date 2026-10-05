#[cfg(target_os = "linux")]
use std::time::Duration;
use stt_core::MAX_TTS_INPUT_CHARS;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

// Four bytes is the maximum UTF-8 width. One extra byte detects output that exceeds the
// largest possible valid TTS input without rejecting 4096 four-byte Unicode characters.
const MAX_TTS_CLIPBOARD_BYTES: usize = MAX_TTS_INPUT_CHARS * 4 + 1;

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

pub async fn read_text(app: &AppHandle) -> Result<String, String> {
    if is_wayland() {
        return wayland_paste().await;
    }
    let handle = app.clone();
    let text = tauri::async_runtime::spawn_blocking(move || handle.clipboard().read_text())
        .await
        .map_err(|_| "Чтение буфера обмена завершилось неожиданно.".to_owned())?
        .map_err(|_| "Не удалось прочитать текст из буфера обмена.".to_owned())?;
    decode_and_validate_text(text.as_bytes())
}

fn decode_and_validate_text(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() >= MAX_TTS_CLIPBOARD_BYTES {
        return Err(format!(
            "Текст в буфере обмена превышает {} символов. Сократите его и повторите попытку.",
            MAX_TTS_INPUT_CHARS
        ));
    }

    let text = std::str::from_utf8(bytes)
        .map_err(|_| "Буфер обмена содержит данные не в текстовом формате UTF-8.".to_owned())?;

    if text.trim().is_empty() {
        return Err("Буфер обмена пуст или содержит только пробелы.".to_owned());
    }
    if text.chars().count() > MAX_TTS_INPUT_CHARS {
        return Err(format!(
            "Текст в буфере обмена превышает {} символов. Сократите его и повторите попытку.",
            MAX_TTS_INPUT_CHARS
        ));
    }

    Ok(text.to_owned())
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

#[cfg(target_os = "linux")]
async fn wayland_paste() -> Result<String, String> {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    use tokio::process::Command;

    let mut command = Command::new("wl-paste");
    command
        .args(["--type", "text/plain", "--no-newline"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
    let mut child = command.spawn().map_err(|_| {
        "Для чтения буфера обмена на Wayland нужен wl-paste. Установите пакет wl-clipboard."
            .to_owned()
    })?;
    let process_group = child.id();
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Не удалось открыть буфер обмена.".to_owned())?;
        let mut bytes = Vec::with_capacity(MAX_TTS_CLIPBOARD_BYTES);
        let mut limited_stdout = stdout.take(MAX_TTS_CLIPBOARD_BYTES as u64);
        limited_stdout
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Не удалось прочитать текст из буфера обмена Wayland.".to_owned())?;
        drop(limited_stdout);

        if bytes.len() >= MAX_TTS_CLIPBOARD_BYTES {
            return Err(format!(
                "Текст в буфере обмена превышает {} символов. Сократите его и повторите попытку.",
                MAX_TTS_INPUT_CHARS
            ));
        }

        let status = child
            .wait()
            .await
            .map_err(|_| "Не удалось завершить чтение буфера обмена Wayland.".to_owned())?;
        if !status.success() {
            return Err("Буфер обмена не содержит текст в формате text/plain или Wayland не разрешил его прочитать.".to_owned());
        }
        decode_and_validate_text(&bytes)
    })
    .await;

    match result {
        Ok(Ok(text)) => Ok(text),
        failure => {
            if let Some(pid) = process_group {
                let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
            }
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            match failure {
                Ok(Err(error)) => Err(error),
                _ => Err(
                    "Чтение буфера обмена на Wayland не завершилось вовремя. Попробуйте снова."
                        .into(),
                ),
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
async fn wayland_copy(_text: String) -> Result<(), String> {
    Err("Буфер Wayland недоступен на этой платформе.".into())
}

#[cfg(not(target_os = "linux"))]
async fn wayland_paste() -> Result<String, String> {
    Err("Буфер Wayland недоступен на этой платформе.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_or_whitespace_text() {
        let error = decode_and_validate_text(" \t\n ".as_bytes()).unwrap_err();
        assert!(error.contains("пуст"));
    }

    #[test]
    fn accepts_unicode_at_character_limit() {
        let text = "😀".repeat(MAX_TTS_INPUT_CHARS);
        assert_eq!(decode_and_validate_text(text.as_bytes()).unwrap(), text);
    }

    #[test]
    fn rejects_invalid_utf8() {
        let error = decode_and_validate_text(&[0xff]).unwrap_err();
        assert!(error.contains("UTF-8"));
    }

    #[test]
    fn preserves_original_whitespace() {
        let text = "  текст\n";
        assert_eq!(decode_and_validate_text(text.as_bytes()).unwrap(), text);
    }
}
