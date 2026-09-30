use crate::StoredData;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

pub fn load_data(path: &Path) -> Result<StoredData, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StoredData::default());
        }
        Err(error) => return Err(format!("Не удалось прочитать файл настроек: {error}")),
    };
    let data: StoredData = serde_json::from_slice(&bytes)
        .map_err(|_| "Файл настроек повреждён. Восстановите его из резервной копии или удалите, чтобы сбросить настройки.".to_owned())?;
    validate_data(&data)?;
    Ok(data)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveOutcome {
    pub durability_warning: Option<String>,
}

/// `Ok` means the rename committed the save; a warning reports unconfirmed durability.
/// `Err` is reserved for failures before that commit.
pub fn save_data(path: &Path, data: &StoredData) -> Result<SaveOutcome, String> {
    save_data_with_directory_sync(path, data, sync_directory)
}

fn save_data_with_directory_sync(
    path: &Path,
    data: &StoredData,
    sync: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<SaveOutcome, String> {
    validate_data(data)?;
    let bytes = serde_json::to_vec_pretty(data)
        .map_err(|_| "Не удалось подготовить настройки к сохранению.".to_owned())?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let filename = path
        .file_name()
        .ok_or_else(|| "Укажите путь к файлу настроек, а не к каталогу.".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Не удалось создать каталог настроек: {error}"))?;

    // A unique sibling and rename keep readers from observing a partial JSON file.
    let (mut file, temporary) = loop {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let mut name = filename.to_os_string();
        name.push(format!(".{}.{}.tmp", std::process::id(), id));
        let temporary = parent.join(name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temporary) {
            Ok(file) => break (file, TemporaryFile(temporary)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Не удалось создать временный файл настроек: {error}"
                ));
            }
        }
    };
    let write_result = file.write_all(&bytes).and_then(|_| file.sync_all());
    // Close before cleanup or rename, including on failure (required on Windows).
    drop(file);
    write_result.map_err(|error| format!("Не удалось записать настройки: {error}"))?;
    fs::rename(&temporary.0, path)
        .map_err(|error| format!("Не удалось заменить файл настроек: {error}"))?;
    let durability_warning = sync(parent).err().map(|error| {
        let mut warning = String::from("Настройки сохранены, но не удалось синхронизировать каталог; сохранность после сбоя питания не подтверждена: ");
        warning.push_str(&error.to_string());
        warning
    });
    Ok(SaveOutcome { durability_warning })
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(path).and_then(|directory| directory.sync_all())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn validate_data(data: &StoredData) -> Result<(), String> {
    data.settings.validate()?;
    data.statistics.validate()
}

struct TemporaryFile(PathBuf);

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Settings;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("stt-core-persistence-{}-{id}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn persistence_roundtrip_replaces_atomically_and_creates_parents() {
        let directory = TestDirectory::new();
        let path = directory.0.join("nested/settings.json");
        let mut data = StoredData::default();
        data.settings.input_device = Some("микрофон-1".into());
        data.statistics.add_recording(3.5).unwrap();
        let outcome = save_data(&path, &data).unwrap();
        assert_eq!(outcome.durability_warning, None);
        data.statistics.add_recording(1.25).unwrap();
        let outcome = save_data(&path, &data).unwrap();
        assert_eq!(outcome.durability_warning, None);
        let restored = load_data(&path).unwrap();
        assert_eq!(restored.settings, data.settings);
        assert_eq!(restored.statistics.recordings, 2);
        assert_eq!(restored.statistics.total_recording_seconds, 4.75);
        assert_eq!(restored.statistics.last_recording_seconds, 1.25);
        let json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let object = json.as_object().unwrap();
        assert_eq!(object.len(), 2);
        assert!(object.contains_key("settings"));
        assert!(object.contains_key("statistics"));
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn normal_save_returns_outcome_without_warning() {
        let directory = TestDirectory::new();
        let path = directory.0.join("settings.json");
        let outcome = save_data(&path, &StoredData::default()).unwrap();
        assert_eq!(outcome.durability_warning, None);
        assert!(path.is_file());
    }

    #[test]
    fn directory_sync_failure_returns_warning_after_committing_save() {
        let directory = TestDirectory::new();
        let path = directory.0.join("settings.json");
        save_data(&path, &StoredData::default()).unwrap();
        let mut data = StoredData::default();
        data.statistics.add_recording(2.5).unwrap();
        let outcome = save_data_with_directory_sync(&path, &data, |parent| {
            assert_eq!(parent, directory.0.as_path());
            // The replacement is already visible before directory synchronization.
            assert_eq!(load_data(&path).unwrap().statistics.recordings, 1);
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "simulated directory sync failure",
            ))
        })
        .unwrap();
        let warning = outcome.durability_warning.unwrap();
        assert!(warning.contains("Настройки сохранены"));
        assert!(warning.contains("сохранность после сбоя питания не подтверждена"));
        assert_eq!(
            load_data(&path).unwrap().statistics.total_recording_seconds,
            2.5
        );
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn missing_and_partial_data_use_defaults_and_ignore_future_fields() {
        let directory = TestDirectory::new();
        let path = directory.0.join("settings.json");
        assert_eq!(load_data(&path).unwrap().settings, Settings::default());
        for json in [
            "{}",
            r#"{"settings": {}, "statistics": {}, "future": true}"#,
            r#"{"settings": {"future": "value"}, "statistics": {"recordings": 2}}"#,
        ] {
            fs::write(&path, json).unwrap();
            let restored = load_data(&path).unwrap();
            assert_eq!(restored.settings, Settings::default());
            assert_eq!(restored.statistics.total_recording_seconds, 0.0);
        }
    }

    #[test]
    fn explicitly_persisted_models_are_preserved_when_defaults_change() {
        let directory = TestDirectory::new();
        let path = directory.0.join("settings.json");
        for model in [
            "gpt-4o-mini-transcribe",
            "gpt-4o-transcribe",
            "whisper-1",
            "gpt-4o-mini-transcribe-2025-12-15",
            "future-ASR_v2.1:stable",
        ] {
            let json = serde_json::json!({ "settings": { "model": model } });
            fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
            let data = load_data(&path).unwrap();
            assert_eq!(data.settings.model, model);
            save_data(&path, &data).unwrap();
            assert_eq!(load_data(&path).unwrap().settings.model, model);
        }
    }

    #[test]
    fn corruption_and_invalid_values_are_not_silently_reset() {
        let directory = TestDirectory::new();
        let path = directory.0.join("settings.json");
        for json in [
            "",
            "{broken",
            "null",
            r#"{"settings": {"model": "invalid/model"}}"#,
            r#"{"settings": {"model": ""}}"#,
            r#"{"statistics": {"total_recording_seconds": -1}}"#,
            r#"{"statistics": {"recordings": "two"}}"#,
        ] {
            fs::write(&path, json).unwrap();
            assert!(load_data(&path).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), json);
        }
        assert!(load_data(&directory.0).is_err());
    }

    #[test]
    fn failed_save_preserves_previous_file_and_cleans_temporary_file() {
        let directory = TestDirectory::new();
        let path = directory.0.join("settings.json");
        save_data(&path, &StoredData::default()).unwrap();
        let previous = fs::read(&path).unwrap();
        let mut invalid = StoredData::default();
        invalid.statistics.total_recording_seconds = f64::NAN;
        assert!(save_data(&path, &invalid).is_err());
        assert_eq!(fs::read(&path).unwrap(), previous);
        let target_directory = directory.0.join("target");
        fs::create_dir(&target_directory).unwrap();
        assert!(save_data(&target_directory, &StoredData::default()).is_err());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
    }
}
