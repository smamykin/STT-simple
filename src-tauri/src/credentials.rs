use keyring::{Entry, Error};
use zeroize::Zeroizing;

const SERVICE: &str = "io.sttsimple.desktop";
const ACCOUNT: &str = "openai-api-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|_| unavailable())
}

pub fn load() -> Result<Option<Zeroizing<String>>, String> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(Zeroizing::new(key))),
        Err(Error::NoEntry) => Ok(None),
        Err(_) => Err(unavailable()),
    }
}

pub fn save(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 4096 || key.chars().any(char::is_whitespace) {
        return Err("Укажите API-ключ OpenAI без пробелов и переносов строки.".into());
    }
    entry()?.set_password(key).map_err(|_| unavailable())
}

pub fn delete() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(_) => Err(unavailable()),
    }
}

fn unavailable() -> String {
    "Не удалось открыть системное хранилище секретов. На Ubuntu проверьте, что GNOME Keyring запущен и разблокирован; на macOS разрешите доступ к Keychain. Ключ не сохраняется в файл.".into()
}
