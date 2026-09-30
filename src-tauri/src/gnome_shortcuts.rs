//! Ubuntu GNOME Wayland custom shortcuts, without spawning `gsettings`.
//!
//! On Wayland, `save_settings` calls `apply` to install/update the shortcut;
//! startup calls the read-only `verify`. Both take the quoted absolute executable
//! + `--toggle` from `shortcuts::wayland_command`. This module is Linux-only.
//!
//! GSettings has no compare-and-swap, cross-path transaction, or compositor grab
//! acknowledgement. We check ownership, conflicts, writability and readbacks;
//! re-read/merge the list before adding our path; and roll back only values still
//! matching our writes. Rollback never restores an old whole list. An external
//! writer can still race between a read and write (including rollback), and dconf
//! notifications may lag. Readback confirms the backend's view, not disk durability
//! or that GNOME Shell accepted the grab. Extension/dynamic grabs and keyboard
//! layout-dependent physical-code vs keysym differences cannot be detected here.
//! GTK keysyms represent the usual layout's key, not a physical Tauri keycode;
//! unusual/unsupported codes are rejected rather than guessed. Mutter's physical
//! `Above_Tab` bindings are another layout-dependent exception. Ownership is a
//! conservative metadata check (name, valid --toggle command, executable basename),
//! not an authenticated marker; relocation with the same basename is supported.

use gio::prelude::*;
use glib::{variant::ToVariant, Variant};
use std::{ffi::CString, path::Path, sync::Mutex};
use tauri_plugin_global_shortcut::{Code, Modifiers};

const MEDIA: &str = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM: &str = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
const LIST: &str = "custom-keybindings";
const PATH: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/stt-simple/";
const NAME: &str = "STT Simple";
static SERIAL: Mutex<()> = Mutex::new(());

/// Check the configured shortcut and command without changing any settings.
/// Missing/stale registration is an error: explicitly save settings to repair it.
pub fn verify(shortcut: &str, command: &str) -> Result<(), String> {
    let _guard = SERIAL.lock().map_err(|_| {
        "Не удалось получить блокировку настройки сочетания клавиш. Перезапустите STT Simple."
    })?;
    check_session()?;
    let desired = Desired::new(shortcut, command)?;
    verify_store(&Gnome::open()?, &desired)
}

/// Create/update only the STT Simple custom shortcut. No other binding is removed
/// to resolve conflicts. On failure, attempt a conditional, narrowly scoped rollback.
pub fn apply(shortcut: &str, command: &str) -> Result<(), String> {
    let _guard = SERIAL.lock().map_err(|_| {
        "Не удалось получить блокировку настройки сочетания клавиш. Перезапустите STT Simple."
    })?;
    check_session()?;
    let desired = Desired::new(shortcut, command)?;
    apply_store(&Gnome::open()?, &desired)
}

fn check_session() -> Result<(), String> {
    let os = std::fs::read_to_string("/etc/os-release").map_err(|e| {
        format!("Не удалось определить, используется ли Ubuntu: {e}. Назначьте системное сочетание клавиш вручную.")
    })?;
    session_supported(
        &os,
        &std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
        &std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
    )?;
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
        return Err(
            "Не найден адрес сеансовой шины D-Bus. Запустите STT Simple в сеансе Ubuntu GNOME Wayland."
                .into(),
        );
    }
    // A memory/keyfile/null backend must not be reported as a GNOME registration.
    let backend = gio::SettingsBackend::default();
    if backend.type_().name() != "DConfSettingsBackend" {
        return Err("Для сочетаний клавиш GNOME нужен механизм хранения GSettings на базе dconf. Установите dconf-gsettings-backend и удалите переопределение переменной GSETTINGS_BACKEND.".into());
    }
    Ok(())
}

fn session_supported(os: &str, desktop: &str, session: &str) -> Result<(), String> {
    let ubuntu = os.lines().any(|line| {
        line.strip_prefix("ID=")
            .map(|v| v.trim_matches(['\'', '"']) == "ubuntu")
            .unwrap_or(false)
    });
    if !ubuntu
        || !desktop.split(':').any(|v| v.eq_ignore_ascii_case("gnome"))
        || !session.eq_ignore_ascii_case("wayland")
    {
        return Err("Автоматическая настройка системных сочетаний поддерживается только в Ubuntu GNOME Wayland. Войдите в этот сеанс или назначьте сочетание вручную в настройках вашей среды, используя показанную команду с --toggle.".into());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Accelerator {
    key: u32,
    mods: u32,
}

fn accelerator(value: &str) -> Result<Accelerator, String> {
    // GTK's <Primary> consults a display. On GNOME/Linux it is Control;
    // normalize it explicitly, and reject unknown tokens GTK might ignore.
    let mut remaining = value.trim();
    let mut canonical = String::new();
    while let Some(tail) = remaining.strip_prefix('<') {
        let end = tail
            .find('>')
            .ok_or("В записи сочетания клавиш не закрыта скобка модификатора.")?;
        let modifier = match tail[..end].to_ascii_lowercase().as_str() {
            "primary" | "control" | "ctrl" | "ctl" => "<Control>",
            "shift" | "shft" => "<Shift>",
            "alt" | "mod1" => "<Alt>",
            "super" | "mod4" => "<Super>",
            "meta" => "<Meta>",
            "hyper" => "<Hyper>",
            "mod2" => "<Mod2>",
            "mod3" => "<Mod3>",
            "mod5" => "<Mod5>",
            "release" => "<Release>",
            _ => return Err("Неизвестный модификатор в сочетании клавиш GNOME.".into()),
        };
        canonical.push_str(modifier);
        remaining = &tail[end + 1..];
    }
    let lower = remaining.to_ascii_lowercase();
    let key_name = match lower.as_str() {
        "enter" | "return" => "Return",
        "esc" | "escape" => "Escape",
        "pageup" | "page_up" | "prior" => "Page_Up",
        "pagedown" | "page_down" | "next" => "Page_Down",
        "space" => "space",
        "tab" => "Tab",
        "backspace" => "BackSpace",
        "delete" => "Delete",
        "insert" => "Insert",
        "home" => "Home",
        "end" => "End",
        "left" => "Left",
        "right" => "Right",
        "up" => "Up",
        "down" => "Down",
        "iso_left_tab" => "ISO_Left_Tab",
        _ => remaining,
    };
    canonical.push_str(key_name);
    let value =
        CString::new(canonical).map_err(|_| "Запись сочетания клавиш содержит нулевой символ.")?;
    let mut key = 0;
    let mut mods = 0;
    // These GTK/GDK C functions are display-independent; unlike gtk-rs's wrapper
    // they require neither gtk_init nor the UI thread. This also permits headless tests.
    unsafe {
        gtk::ffi::gtk_accelerator_parse(value.as_ptr(), &mut key, &mut mods);
        key = gtk::gdk::ffi::gdk_keyval_to_lower(key);
    }
    if key == 0 {
        return Err("Не удалось разобрать сочетание клавиш GNOME.".into());
    }
    use gtk::gdk::ffi::{GDK_MOD4_MASK, GDK_SHIFT_MASK, GDK_SUPER_MASK};
    // GNOME maps Alt to Mod1 and Super to Mod4. Preserve Meta/Hyper/other masks:
    // they are not aliases for Super and must not be silently reinterpreted.
    if mods & GDK_MOD4_MASK != 0 {
        mods = (mods & !GDK_MOD4_MASK) | GDK_SUPER_MASK;
    }
    // ISO_Left_Tab and Shift+Tab denote the same key combination.
    if key == 0xfe20 {
        key = 0xff09;
        mods |= GDK_SHIFT_MASK;
    }

    Ok(Accelerator { key, mods })
}

fn gtk_shortcut(value: &str) -> Result<(String, Accelerator), String> {
    let shortcut = crate::shortcuts::validate(value)?;
    if shortcut.mods.is_empty() {
        return Err(
            "Для пользовательского сочетания GNOME нельзя использовать клавишу без модификатора. Добавьте Control, Alt, Shift или Super.".into(),
        );
    }
    let allowed = Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER;
    if !(shortcut.mods & !allowed).is_empty() {
        return Err(
            "Этот модификатор нельзя преобразовать в поддерживаемое сочетание GNOME.".into(),
        );
    }
    let key = key_name(shortcut.key)?;
    let mut binding = String::new();
    for (modifier, name) in [
        (Modifiers::CONTROL, "<Control>"),
        (Modifiers::ALT, "<Alt>"),
        (Modifiers::SHIFT, "<Shift>"),
        (Modifiers::SUPER, "<Super>"),
    ] {
        if shortcut.mods.contains(modifier) {
            binding.push_str(name);
        }
    }
    binding.push_str(&key);
    let parsed = accelerator(&binding)?;
    Ok((binding, parsed))
}

fn key_name(code: Code) -> Result<String, String> {
    let code_name = code.to_string();
    if let Some(letter) = code_name.strip_prefix("Key") {
        if letter.len() == 1 && letter.as_bytes()[0].is_ascii_uppercase() {
            return Ok(letter.to_ascii_lowercase());
        }
    }
    if let Some(digit) = code_name.strip_prefix("Digit") {
        if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() {
            return Ok(digit.into());
        }
    }
    if let Some(number) = code_name
        .strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
    {
        if (1..=24).contains(&number) {
            return Ok(code_name);
        }
    }
    if let Some(digit) = code_name.strip_prefix("Numpad") {
        if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() {
            return Ok(format!("KP_{digit}"));
        }
    }
    use Code::*;
    let name = match code {
        Backquote => "grave", Backslash => "backslash", BracketLeft => "bracketleft", BracketRight => "bracketright",
        Comma => "comma", Equal => "equal", Minus => "minus", Period => "period", Quote => "apostrophe", Semicolon => "semicolon", Slash => "slash",
        Backspace => "BackSpace", CapsLock => "Caps_Lock", Enter => "Return", Space => "space", Tab => "Tab", Escape => "Escape",
        Delete => "Delete", End => "End", Home => "Home", Insert => "Insert", PageDown => "Page_Down", PageUp => "Page_Up",
        PrintScreen => "Print", ScrollLock => "Scroll_Lock", Pause => "Pause", NumLock => "Num_Lock",
        ArrowDown => "Down", ArrowLeft => "Left", ArrowRight => "Right", ArrowUp => "Up",
        NumpadAdd => "KP_Add", NumpadDecimal => "KP_Decimal", NumpadDivide => "KP_Divide", NumpadEnter => "KP_Enter",
        NumpadEqual => "KP_Equal", NumpadMultiply => "KP_Multiply", NumpadSubtract => "KP_Subtract",
        AudioVolumeDown => "XF86AudioLowerVolume", AudioVolumeUp => "XF86AudioRaiseVolume", AudioVolumeMute => "XF86AudioMute",
        MediaPlay => "XF86AudioPlay", MediaPause => "XF86AudioPause", MediaStop => "XF86AudioStop", MediaTrackNext => "XF86AudioNext", MediaTrackPrevious => "XF86AudioPrev",
        // Play and PlayPause would collapse to the same XF86 keysym, losing the
        // distinction in Tauri. Do not silently choose one interpretation.
        _ => return Err(format!("Клавишу {code_name} нельзя однозначно преобразовать в сочетание GNOME. Выберите букву, цифру, функциональную клавишу, клавишу навигации или поддерживаемую клавишу цифрового блока.")),
    };
    Ok(name.into())
}

// GNOME uses g_shell_parse_argv, not a shell. Accept exactly a quoted absolute
// executable and --toggle; reject extra arguments, expansion and relative paths.
fn executable(command: &str) -> Result<String, String> {
    if !command.starts_with(['\'', '"']) || command.contains('\0') || command.contains('\n') {
        return Err(
            "Команда сочетания должна содержать абсолютный путь к исполняемому файлу в кавычках и аргумент --toggle.".into(),
        );
    }
    let argv = glib::shell_parse_argv(command)
        .map_err(|e| format!("Некорректная команда сочетания клавиш: {e}"))?;
    if argv.len() != 2 || argv[1] != "--toggle" || !Path::new(&argv[0]).is_absolute() {
        return Err(
            "Команда сочетания должна содержать только абсолютный путь к исполняемому файлу в кавычках и аргумент --toggle.".into(),
        );
    }
    argv[0].clone().into_string().map_err(|_| {
        "Путь к исполняемому файлу в команде сочетания не является корректной строкой UTF-8.".into()
    })
}

struct Desired {
    binding: String,
    accelerator: Accelerator,
    command: String,
    executable: String,
}
impl Desired {
    fn new(shortcut: &str, command: &str) -> Result<Self, String> {
        let (binding, accelerator) = gtk_shortcut(shortcut)?;
        Ok(Self {
            binding,
            accelerator,
            command: command.into(),
            executable: executable(command)?,
        })
    }
    fn value(&self, key: Key) -> Variant {
        match key {
            Key::Name => NAME.to_variant(),
            Key::Command => self.command.to_variant(),
            Key::Binding => self.binding.to_variant(),
            Key::List => unreachable!(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Key {
    List,
    Name,
    Command,
    Binding,
}
impl Key {
    fn name(self) -> &'static str {
        match self {
            Self::List => LIST,
            Self::Name => "name",
            Self::Command => "command",
            Self::Binding => "binding",
        }
    }
}
const OWN_KEYS: [Key; 3] = [Key::Name, Key::Command, Key::Binding];

#[derive(Clone, Debug, PartialEq)]
struct Saved {
    value: Variant,
    user: Option<Variant>,
}
trait Store {
    fn read(&self, key: Key) -> Saved;
    fn writable(&self, key: Key) -> bool;
    fn write(&self, key: Key, value: Option<&Variant>) -> Result<(), String>;
    fn conflicts(&self, target: Accelerator) -> Result<(), String>;
}

fn paths(store: &impl Store) -> Result<Vec<String>, String> {
    store.read(Key::List).value.get().ok_or_else(|| {
        "Параметр GNOME custom-keybindings имеет неверный тип: ожидается массив строк. Проверьте схему media-keys.".into()
    })
}
fn text(value: &Saved) -> Result<&str, String> {
    value.value.str().ok_or_else(|| {
        "Схема пользовательского сочетания GNOME содержит значение неожиданного типа.".into()
    })
}
fn own_snapshot(store: &impl Store) -> [Saved; 3] {
    OWN_KEYS.map(|key| store.read(key))
}
fn ownership(own: &[Saved; 3], desired: &Desired) -> Result<(), String> {
    // Only a completely unused path, or recognizable STT Simple data, is ours.
    if own
        .iter()
        .all(|v| v.user.is_none() && v.value.str() == Some(""))
    {
        return Ok(());
    }
    let old_executable = executable(text(&own[1])?).ok();
    if text(&own[0])? == NAME
        && old_executable.as_ref().is_some_and(|old| {
            Path::new(old).file_name() == Path::new(&desired.executable).file_name()
        })
    {
        return Ok(());
    }
    Err(format!("Зарезервированный путь сочетания STT Simple {PATH} содержит посторонние данные. Переместите или удалите эту запись вручную в настройках GNOME; приложение не будет её перезаписывать."))
}

fn verify_store(store: &impl Store, desired: &Desired) -> Result<(), String> {
    let own = own_snapshot(store);
    ownership(&own, desired)?;
    store.conflicts(desired.accelerator)?;
    if !paths(store)?.iter().any(|p| p == PATH)
        || own[0].value.str() != Some(NAME)
        || own[1].value.str() != Some(desired.command.as_str())
        || accelerator(text(&own[2])?).ok() != Some(desired.accelerator)
        || own_snapshot(store) != own
    {
        return Err("Сочетание STT Simple в GNOME отсутствует или отличается от настроек приложения. Сохраните настройки, чтобы создать или обновить его, либо проверьте настройки GNOME → Клавиатура → Пользовательские комбинации.".into());
    }
    Ok(())
}

struct Change {
    key: Key,
    before: Saved,
    written: Variant,
}
fn put(
    store: &impl Store,
    key: Key,
    before: Saved,
    value: Variant,
    journal: &mut Vec<Change>,
) -> Result<(), String> {
    if before.value == value {
        return Ok(());
    }
    if !store.writable(key) {
        return Err(format!("Параметр GNOME {} заблокирован. Попросите администратора разрешить его изменение или используйте другое сочетание.", key.name()));
    }
    if store.read(key) != before {
        return Err(
            "Сочетания клавиш GNOME были изменены другим процессом. Повторите сохранение настроек."
                .into(),
        );
    }
    // Journal before writing: even a failed write may have changed the backend.
    journal.push(Change {
        key,
        before,
        written: value.clone(),
    });
    store.write(key, Some(&value))?;
    let after = store.read(key);
    if after.value != value || after.user.as_ref() != Some(&value) {
        return Err(format!(
            "GNOME не сохранил параметр {}. Проверьте права доступа к dconf и текущему сеансу, затем повторите попытку.",
            key.name()
        ));
    }
    Ok(())
}

fn apply_store(store: &impl Store, desired: &Desired) -> Result<(), String> {
    let initial = own_snapshot(store);
    ownership(&initial, desired)?;
    store.conflicts(desired.accelerator)?;
    let initial_paths = paths(store)?;
    // Check locks before making the first change, including the list when needed.
    for (key, old) in OWN_KEYS.into_iter().zip(&initial) {
        if old.value != desired.value(key) && !store.writable(key) {
            return Err(format!(
                "Параметр GNOME {} недоступен для записи. Проверьте блокировки dconf, установленные администратором.",
                key.name()
            ));
        }
    }
    if !initial_paths.iter().any(|p| p == PATH) && !store.writable(Key::List) {
        return Err(
            "Список пользовательских сочетаний GNOME заблокирован. Проверьте блокировки dconf, установленные администратором.".into(),
        );
    }
    let mut journal = Vec::new();
    let result = (|| {
        let mut expected = initial;
        for (i, key) in OWN_KEYS.into_iter().enumerate() {
            if own_snapshot(store) != expected {
                return Err(
                    "Сочетание STT Simple было изменено другим процессом. Повторите сохранение настроек.".into(),
                );
            }
            let value = desired.value(key);
            let changed = expected[i].value != value;
            put(store, key, expected[i].clone(), value.clone(), &mut journal)?;
            if changed {
                // Do not adopt an external update observed after our readback.
                expected[i] = Saved {
                    user: Some(value.clone()),
                    value,
                };
            }
        }
        if own_snapshot(store) != expected {
            return Err(
                "Сочетание STT Simple было изменено другим процессом. Повторите сохранение настроек.".into(),
            );
        }
        // Re-scan conflicts and merge the latest list, not the initial snapshot.
        store.conflicts(desired.accelerator)?;
        let before = store.read(Key::List);
        let mut current: Vec<String> = before
            .value
            .get()
            .ok_or("Список пользовательских сочетаний GNOME имеет неверный тип.")?;
        if !current.iter().any(|p| p == PATH) {
            current.push(PATH.into());
            put(store, Key::List, before, current.to_variant(), &mut journal)?;
        }
        verify_store(store, desired)
    })();
    if let Err(error) = result {
        let rollback_errors = rollback(store, &journal);
        if rollback_errors.is_empty() {
            return Err(error);
        }
        return Err(format!("{error} Не удалось полностью отменить изменения: {}. Проверьте запись STT Simple в настройках GNOME перед повторной попыткой.", rollback_errors.join("; ")));
    }
    Ok(())
}

fn rollback(store: &impl Store, journal: &[Change]) -> Vec<String> {
    let mut errors = Vec::new();
    for change in journal.iter().rev() {
        let current = store.read(change.key);
        if current == change.before {
            continue;
        }
        let restore = if change.key == Key::List {
            let Some(mut list) = current.value.get::<Vec<String>>() else {
                errors.push("тип списка сочетаний изменился".into());
                continue;
            };
            let Some(old) = change.before.value.get::<Vec<String>>() else {
                errors.push("исходный список сочетаний имеет неверный тип".into());
                continue;
            };
            if old.iter().any(|p| p == PATH) {
                continue;
            }
            // Remove only the path we appended; retain concurrent unrelated entries
            // and ordering. Do not replace the list with its stale original value.
            if let Some(index) = list.iter().rposition(|p| p == PATH) {
                list.remove(index);
            } else {
                continue;
            }
            if list == old {
                change.before.user.clone()
            } else {
                Some(list.to_variant())
            }
        } else {
            if current.value != change.written || current.user.as_ref() != Some(&change.written) {
                errors.push(format!(
                    "параметр {} изменён другим процессом и не восстановлен",
                    change.key.name()
                ));
                continue;
            }
            change.before.user.clone()
        };
        if store.read(change.key) != current {
            errors.push(format!(
                "параметр {} изменился во время отмены изменений",
                change.key.name()
            ));
            continue;
        }
        if !store.writable(change.key) {
            errors.push(format!("параметр {} был заблокирован", change.key.name()));
            continue;
        }
        if let Err(e) = store.write(change.key, restore.as_ref()) {
            errors.push(e);
            continue;
        }
        let after = store.read(change.key);
        let expected_value = restore.as_ref().unwrap_or(&change.before.value);
        if after.user != restore || &after.value != expected_value {
            errors.push(format!(
                "проверка восстановления параметра {} не пройдена",
                change.key.name()
            ));
        }
    }
    errors
}

struct Gnome {
    source: gio::SettingsSchemaSource,
    media: gio::Settings,
    own: gio::Settings,
    custom_schema: gio::SettingsSchema,
}
fn settings(schema: &gio::SettingsSchema, path: Option<&str>) -> gio::Settings {
    gio::Settings::new_full(schema, None::<&gio::SettingsBackend>, path)
}
fn schema(source: &gio::SettingsSchemaSource, id: &str) -> Result<gio::SettingsSchema, String> {
    source.lookup(id, true).ok_or_else(|| format!("Не найдена схема GSettings GNOME {id}. Установите gnome-settings-daemon, gsettings-desktop-schemas и gnome-shell; запустите приложение в Ubuntu GNOME."))
}
fn check_key(schema: &gio::SettingsSchema, key: &str, expected: &str) -> Result<(), String> {
    if !schema.has_key(key) || schema.key(key).value_type().as_str() != expected {
        return Err(format!("В схеме GNOME {} отсутствует совместимый параметр {key} типа {expected}. Восстановите или обновите пакеты GNOME.", schema.id()));
    }
    Ok(())
}
impl Gnome {
    fn open() -> Result<Self, String> {
        let source = gio::SettingsSchemaSource::default()
            .ok_or("Схемы GSettings не найдены. Установите пакеты настроек GNOME.")?;
        let media_schema = schema(&source, MEDIA)?;
        check_key(&media_schema, LIST, "as")?;
        if media_schema.path().is_none() {
            return Err(
                "В схеме GNOME media-keys отсутствует ожидаемый фиксированный путь.".into(),
            );
        }
        let custom_schema = schema(&source, CUSTOM)?;
        if custom_schema.path().is_some() {
            return Err("Схема пользовательского сочетания GNOME должна поддерживать отдельный путь для каждой записи.".into());
        }
        for key in OWN_KEYS {
            check_key(&custom_schema, key.name(), "s")?;
        }
        Ok(Self {
            media: settings(&media_schema, None),
            own: settings(&custom_schema, Some(PATH)),
            source,
            custom_schema,
        })
    }
    fn target(&self, key: Key) -> &gio::Settings {
        if key == Key::List {
            &self.media
        } else {
            &self.own
        }
    }
    fn scan(&self, schema: &gio::SettingsSchema, target: Accelerator) -> Result<(), String> {
        if schema.path().is_none() {
            return Err(format!(
                "Во встроенной схеме GNOME {} отсутствует ожидаемый фиксированный путь.",
                schema.id()
            ));
        }
        let values = settings(schema, None);
        for key in schema.list_keys() {
            if schema.id() == MEDIA && key == LIST {
                continue;
            }
            let value = values.value(&key);
            let bindings = if let Some(bindings) = value.get::<Vec<String>>() {
                bindings
            } else if let Some(binding) = value.str() {
                vec![binding.into()]
            } else {
                continue;
            };
            for binding in bindings {
                conflict(&binding, target, &format!("{} / {key}", schema.id()))?;
            }
        }
        Ok(())
    }
}
impl Store for Gnome {
    fn read(&self, key: Key) -> Saved {
        let target = self.target(key);
        Saved {
            value: target.value(key.name()),
            user: target.user_value(key.name()),
        }
    }
    fn writable(&self, key: Key) -> bool {
        self.target(key).is_writable(key.name())
    }
    fn write(&self, key: Key, value: Option<&Variant>) -> Result<(), String> {
        if let Some(value) = value {
            self.target(key)
                .set_value(key.name(), value)
                .map_err(|e| format!("Не удалось записать параметр GNOME {}: {e}", key.name()))?;
        } else {
            self.target(key).reset(key.name());
        }
        gio::Settings::sync();
        Ok(())
    }
    fn conflicts(&self, target: Accelerator) -> Result<(), String> {
        for path in paths(self)? {
            if path == PATH {
                continue;
            }
            // Validate before passing an untrusted path to GSettings (which can abort).
            if !valid_path(&path) {
                return Err(format!("Список пользовательских сочетаний GNOME содержит некорректный путь {path:?}. Исправьте запись в настройках GNOME перед сохранением."));
            }
            let custom = settings(&self.custom_schema, Some(&path));
            conflict(
                custom.string("binding").as_str(),
                target,
                &format!(
                    "пользовательское сочетание {:?} ({path})",
                    custom.string("name")
                ),
            )?;
        }
        for id in [
            MEDIA,
            "org.gnome.desktop.wm.keybindings",
            "org.gnome.shell.keybindings",
        ] {
            self.scan(&schema(&self.source, id)?, target)?;
        }
        // Mutter schemas vary across GNOME versions. Scan those installed,
        // without treating an absent optional schema as a broken core setup.
        for id in [
            "org.gnome.mutter.keybindings",
            "org.gnome.mutter.wayland.keybindings",
            "org.gnome.mutter",
        ] {
            if let Some(schema) = self.source.lookup(id, true) {
                self.scan(&schema, target)?;
            }
        }
        Ok(())
    }
}
fn valid_path(path: &str) -> bool {
    path.starts_with('/')
        && path.ends_with('/')
        && !path.contains("//")
        && path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'/' | b'-' | b'_'))
}
fn conflict(binding: &str, target: Accelerator, source: &str) -> Result<(), String> {
    if accelerator(binding).ok() == Some(target) {
        return Err(format!("Сочетание клавиш уже назначено: {source}. Выберите другое сочетание или измените существующее назначение вручную в настройках GNOME."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const COMMAND: &str = "\"/opt/STT Simple/stt-simple\" --toggle";
    struct Fake {
        values: RefCell<HashMap<Key, Saved>>,
        writes: RefCell<Vec<Key>>,
        locked: Vec<Key>,
        fail: Option<Key>,
        fail_after: Option<Key>,
        bindings: RefCell<Vec<String>>,
        concurrent_list: bool,
        drop_write: Option<Key>,
    }
    impl Fake {
        fn new(list: &[&str]) -> Self {
            let mut values = HashMap::new();
            values.insert(
                Key::List,
                Saved {
                    value: list
                        .iter()
                        .map(|p| p.to_string())
                        .collect::<Vec<_>>()
                        .to_variant(),
                    user: None,
                },
            );
            for key in OWN_KEYS {
                values.insert(
                    key,
                    Saved {
                        value: "".to_variant(),
                        user: None,
                    },
                );
            }
            Self {
                values: RefCell::new(values),
                writes: RefCell::new(Vec::new()),
                locked: vec![],
                fail: None,
                fail_after: None,
                bindings: RefCell::new(vec![]),
                concurrent_list: false,
                drop_write: None,
            }
        }
        fn set(&self, key: Key, value: Variant) {
            self.values.borrow_mut().insert(
                key,
                Saved {
                    user: Some(value.clone()),
                    value,
                },
            );
        }
    }
    impl Store for Fake {
        fn read(&self, key: Key) -> Saved {
            self.values.borrow()[&key].clone()
        }
        fn writable(&self, key: Key) -> bool {
            !self.locked.contains(&key)
        }
        fn write(&self, key: Key, value: Option<&Variant>) -> Result<(), String> {
            self.writes.borrow_mut().push(key);
            if self.fail == Some(key) {
                return Err("injected write failure".into());
            }
            if self.drop_write == Some(key) && value.is_some() {
                return Ok(());
            }
            let default = if key == Key::List {
                Vec::<String>::new().to_variant()
            } else {
                "".to_variant()
            };
            self.values.borrow_mut().insert(
                key,
                Saved {
                    value: value.cloned().unwrap_or(default),
                    user: value.cloned(),
                },
            );
            if self.concurrent_list && key == Key::Command && value.is_some() {
                self.set(Key::List, vec!["/other/", "/concurrent/"].to_variant());
            }
            if self.concurrent_list
                && key == Key::List
                && value.is_some_and(|v| v.get::<Vec<String>>().unwrap().iter().any(|p| p == PATH))
            {
                let mut list = paths(self)?;
                list.push("/late/".into());
                self.set(Key::List, list.to_variant());
                self.bindings.borrow_mut().push("<Super>r".into()); // failure after list write
            }
            if self.fail_after == Some(key) && value.is_some() {
                return Err("injected failure after write".into());
            }
            Ok(())
        }
        fn conflicts(&self, target: Accelerator) -> Result<(), String> {
            for binding in self.bindings.borrow().iter() {
                conflict(binding, target, "fake built-in/custom")?;
            }
            Ok(())
        }
    }
    fn desired() -> Desired {
        Desired::new("Super+R", COMMAND).unwrap()
    }

    #[test]
    fn preserves_list_and_other_settings_and_is_idempotent() {
        let fake = Fake::new(&["/other/", "/other/", "/third/"]);
        apply_store(&fake, &desired()).unwrap();
        assert_eq!(
            paths(&fake).unwrap(),
            ["/other/", "/other/", "/third/", PATH]
        );
        assert_eq!(fake.read(Key::Name).value.str(), Some(NAME));
        let writes = fake.writes.borrow().len();
        apply_store(&fake, &desired()).unwrap();
        verify_store(&fake, &desired()).unwrap();
        assert_eq!(fake.writes.borrow().len(), writes);
    }
    #[test]
    fn self_updates_and_relocated_executable() {
        let fake = Fake::new(&[]);
        apply_store(&fake, &desired()).unwrap();
        let next = Desired::new("Ctrl+Alt+Space", "\"/new/stt-simple\" --toggle").unwrap();
        apply_store(&fake, &next).unwrap();
        verify_store(&fake, &next).unwrap();
        assert_eq!(paths(&fake).unwrap(), [PATH]);
    }
    #[test]
    fn verify_never_writes_even_missing_or_stale() {
        let fake = Fake::new(&[]);
        assert!(verify_store(&fake, &desired()).is_err());
        assert!(fake.writes.borrow().is_empty());
        apply_store(&fake, &desired()).unwrap();
        fake.writes.borrow_mut().clear();
        assert!(verify_store(&fake, &Desired::new("Ctrl+R", COMMAND).unwrap()).is_err());
        assert!(fake.writes.borrow().is_empty());
    }
    #[test]
    fn foreign_name_command_and_explicit_empty_path_are_protected() {
        for (name, command) in [
            ("Other app", COMMAND),
            (NAME, "\"/usr/bin/other\" --toggle"),
            (NAME, "\"/opt/stt-simple\" --unrelated"),
            ("", ""),
        ] {
            let fake = Fake::new(&[PATH]);
            fake.set(Key::Name, name.to_variant());
            fake.set(Key::Command, command.to_variant());
            let before = own_snapshot(&fake);
            assert!(apply_store(&fake, &desired()).is_err());
            assert_eq!(own_snapshot(&fake), before);
            assert!(fake.writes.borrow().is_empty());
        }
    }
    #[test]
    fn conflicts_are_detected_before_any_write() {
        for binding in ["<Super>R", "<Mod4>r", "<Control><Mod1>space"] {
            let fake = Fake::new(&[]);
            fake.bindings.borrow_mut().push(binding.into());
            let request = if binding.contains("Control") {
                Desired::new("Ctrl+Alt+Space", COMMAND).unwrap()
            } else {
                desired()
            };
            assert!(apply_store(&fake, &request)
                .unwrap_err()
                .contains("уже назначено"));
            assert!(fake.writes.borrow().is_empty());
        }
    }
    #[test]
    fn aliases_case_and_key_synonyms() {
        for (a, b) in [
            ("<Primary><Alt>R", "<Control><Mod1>r"),
            ("<Ctrl>Prior", "<Control>Page_Up"),
            ("<Super>ISO_Left_Tab", "<Mod4><Shift>Tab"),
        ] {
            assert_eq!(accelerator(a).unwrap(), accelerator(b).unwrap());
        }
        assert_ne!(
            accelerator("<Meta>r").unwrap(),
            accelerator("<Super>r").unwrap()
        );
        assert_ne!(
            accelerator("<Control>KP_Enter").unwrap(),
            accelerator("<Control>Return").unwrap()
        );
    }
    #[test]
    fn tauri_mapping_covers_common_codes_and_rejects_bare_or_ambiguous() {
        for (input, gtk) in [
            ("Ctrl+KeyR", "<Control>r"),
            ("Control+Alt+Space", "<Control><Alt>space"),
            ("Super+PageUp", "<Super>Prior"),
            ("Ctrl+NumEnter", "<Control>KP_Enter"),
            ("Alt+F24", "<Alt>F24"),
            ("Ctrl+;", "<Control>semicolon"),
            ("Super+VolumeUp", "<Super>XF86AudioRaiseVolume"),
        ] {
            assert_eq!(gtk_shortcut(input).unwrap().1, accelerator(gtk).unwrap());
        }
        for input in [
            "R",
            "F12",
            "Ctrl+MediaPlayPause",
            "Ctrl+Unidentified",
            "Ctrl+Alt",
        ] {
            assert!(gtk_shortcut(input).is_err(), "{input}");
        }
    }
    #[test]
    fn command_validation_and_quoting() {
        assert_eq!(executable(COMMAND).unwrap(), "/opt/STT Simple/stt-simple");
        assert_eq!(
            executable("\"/opt/a\\\"b/stt-simple\" --toggle").unwrap(),
            "/opt/a\"b/stt-simple"
        );
        for command in [
            "stt-simple --toggle",
            "\"relative\" --toggle",
            "\"/bin/stt-simple\" --toggle --extra",
            "\"/bin/stt-simple\"",
            "\"/bin/stt-simple\" --toggle\n",
        ] {
            assert!(executable(command).is_err());
        }
    }
    #[test]
    fn locks_are_checked_before_writing() {
        for key in [Key::Name, Key::Command, Key::Binding, Key::List] {
            let mut fake = Fake::new(&[]);
            fake.locked.push(key);
            assert!(apply_store(&fake, &desired()).is_err());
            assert!(fake.writes.borrow().is_empty());
        }
    }
    #[test]
    fn failed_writes_restore_only_our_changes_including_user_defaults() {
        for key in [Key::Command, Key::Binding, Key::List] {
            let mut fake = Fake::new(&[]);
            fake.fail = Some(key);
            let before = own_snapshot(&fake);
            assert!(apply_store(&fake, &desired()).is_err());
            assert_eq!(own_snapshot(&fake), before);
            assert!(paths(&fake).unwrap().is_empty());
        }
    }
    #[test]
    fn failure_after_successful_write_is_also_rolled_back() {
        for key in [Key::Name, Key::Command, Key::Binding, Key::List] {
            let mut fake = Fake::new(&[]);
            fake.fail_after = Some(key);
            let before = own_snapshot(&fake);
            assert!(apply_store(&fake, &desired()).is_err());
            assert_eq!(own_snapshot(&fake), before);
            assert!(paths(&fake).unwrap().is_empty());
        }
    }

    #[test]
    fn failed_self_update_restores_previous_binding_command() {
        let mut fake = Fake::new(&[]);
        apply_store(&fake, &desired()).unwrap();
        let before = own_snapshot(&fake);
        fake.fail = Some(Key::Binding);
        assert!(apply_store(
            &fake,
            &Desired::new("Alt+F10", "\"/new/stt-simple\" --toggle").unwrap()
        )
        .is_err());
        assert_eq!(own_snapshot(&fake), before);
        assert_eq!(paths(&fake).unwrap(), [PATH]);
    }
    #[test]
    fn readback_failure_rolls_back() {
        let mut fake = Fake::new(&[]);
        fake.drop_write = Some(Key::Binding);
        assert!(apply_store(&fake, &desired())
            .unwrap_err()
            .contains("не сохранил"));
        assert!(own_snapshot(&fake).iter().all(|v| v.user.is_none()));
    }
    #[test]
    fn rollback_preserves_concurrent_unrelated_list_updates() {
        let mut fake = Fake::new(&["/other/"]);
        fake.concurrent_list = true;
        assert!(apply_store(&fake, &desired()).is_err());
        assert_eq!(paths(&fake).unwrap(), ["/other/", "/concurrent/", "/late/"]);
        assert!(own_snapshot(&fake).iter().all(|v| v.user.is_none()));
    }
    #[test]
    fn rollback_does_not_overwrite_external_own_key_change() {
        let fake = Fake::new(&[]);
        let before = fake.read(Key::Name);
        fake.set(Key::Name, "External".to_variant());
        let errors = rollback(
            &fake,
            &[Change {
                key: Key::Name,
                before,
                written: NAME.to_variant(),
            }],
        );
        assert_eq!(fake.read(Key::Name).value.str(), Some("External"));
        assert_eq!(errors.len(), 1);
        assert!(fake.writes.borrow().is_empty());
    }
    #[test]
    #[ignore = "requires a real Ubuntu GNOME Wayland session; reads settings only"]
    fn readonly_gnome_session_check() {
        check_session().expect("Ubuntu GNOME Wayland with session dconf is required");
        let gnome = Gnome::open().expect("GNOME shortcut schemas must be installed");
        let before = (gnome.read(Key::List), own_snapshot(&gnome));
        let result = verify("Super+R", &crate::shortcuts::wayland_command());
        eprintln!("Read-only GNOME shortcut verification: {result:?}");
        assert_eq!(gnome.read(Key::List), before.0);
        assert_eq!(own_snapshot(&gnome), before.1);
    }

    #[test]
    fn session_and_paths_reject_other_desktops_and_bad_data() {
        assert!(session_supported("ID=ubuntu\n", "ubuntu:GNOME", "wayland").is_ok());
        for (os, desktop, session) in [
            ("ID=debian", "GNOME", "wayland"),
            ("ID=ubuntu", "KDE", "wayland"),
            ("ID=ubuntu", "GNOME", "x11"),
        ] {
            assert!(session_supported(os, desktop, session).is_err());
        }
        assert!(valid_path(PATH));
        for path in ["relative/", "/no-end", "/bad//path/", "/bad\0/"] {
            assert!(!valid_path(path));
        }
    }
}
