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

#[cfg(not(target_os = "macos"))]
pub fn request_permission() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
pub fn paste() -> Result<(), String> {
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

#[cfg(not(target_os = "macos"))]
pub fn paste() -> Result<(), String> {
    Err(
        "Автоматическая вставка поддерживается только на macOS. Текст остался в буфере обмена."
            .into(),
    )
}
