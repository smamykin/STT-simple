//! Shared settings, local persistence, WAV encoding, and direct speech transcription.
//! API keys and transcripts are intentionally absent from persisted data.

mod audio;
mod client;
mod persistence;

pub use audio::encode_wav;
pub use client::OpenAiClient;
pub use persistence::{load_data, save_data, SaveOutcome};

use serde::{Deserialize, Serialize};

pub const MAX_RECORDING_SECONDS: u64 = 600;

pub(crate) const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
pub const DEFAULT_MODEL: &str = "gpt-transcribe";

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub shortcut: String,
    pub model: String,
    pub input_device: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: if cfg!(target_os = "macos") {
                "Control+Super+R"
            } else {
                "Super+R"
            }
            .to_owned(),
            model: DEFAULT_MODEL.to_owned(),
            input_device: None,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        validate_model(&self.model)?;
        if self.shortcut.trim().is_empty() || self.shortcut.chars().count() > 128 {
            return Err("Укажите сочетание клавиш длиной от 1 до 128 символов.".into());
        }
        if self
            .input_device
            .as_ref()
            .map_or(false, |device| device.chars().count() > 512)
        {
            return Err("Идентификатор микрофона не должен превышать 512 символов.".into());
        }
        Ok(())
    }
}

// Format validation only; OpenAI decides availability and endpoint compatibility.
pub(crate) fn validate_model(model: &str) -> Result<(), String> {
    let bytes = model.as_bytes();
    if !(1..=128).contains(&bytes.len())
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        return Err("Некорректный идентификатор модели. Используйте от 1 до 128 ASCII-символов: первая буква или цифра, далее буквы, цифры и . _ - : без пробелов.".into());
    }
    Ok(())
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Statistics {
    pub last_recording_seconds: f64,
    pub total_recording_seconds: f64,
    pub recordings: u64,
}

impl Statistics {
    pub fn add_recording(&mut self, seconds: f64) -> Result<(), String> {
        if !seconds.is_finite() || seconds <= 0.0 || seconds > (MAX_RECORDING_SECONDS + 1) as f64 {
            return Err(
                "Длительность записи должна быть положительной и не превышать 601 секунду.".into(),
            );
        }
        self.validate()?;
        let total = self.total_recording_seconds + seconds;
        let count = self
            .recordings
            .checked_add(1)
            .ok_or_else(|| "Счётчик записей переполнен.".to_owned())?;
        if !total.is_finite() {
            return Err("Суммарная длительность записей переполнена.".into());
        }
        self.last_recording_seconds = seconds;
        self.total_recording_seconds = total;
        self.recordings = count;
        Ok(())
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if !self.last_recording_seconds.is_finite()
            || self.last_recording_seconds < 0.0
            || self.last_recording_seconds > (MAX_RECORDING_SECONDS + 1) as f64
            || !self.total_recording_seconds.is_finite()
            || self.total_recording_seconds < 0.0
        {
            return Err("Некорректная статистика записей в файле настроек.".into());
        }
        Ok(())
    }
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct StoredData {
    pub settings: Settings,
    pub statistics: Statistics,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_and_valid_model_ids() {
        let mut settings = Settings::default();
        assert_eq!(DEFAULT_MODEL, "gpt-transcribe");
        assert_eq!(settings.model, DEFAULT_MODEL);
        assert_eq!(settings.input_device, None);
        assert_eq!(
            settings.shortcut,
            if cfg!(target_os = "macos") {
                "Control+Super+R"
            } else {
                "Super+R"
            }
        );
        for model in [
            "gpt-transcribe",
            "gpt-4o-mini-transcribe",
            "gpt-4o-transcribe",
            "whisper-1",
            "gpt-4o-mini-transcribe-2025-12-15",
            "gpt-4o-transcribe-diarize",
            "gpt-4o-transcribe-diarize-2026-01-01",
            "future-ASR_v2.1:stable",
            "unknown",
            "A",
            "7",
        ] {
            settings.model = model.into();
            assert!(settings.validate().is_ok(), "{model}");
        }
        settings.model = "a".repeat(128);
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn rejects_malformed_model_ids_without_echoing_them() {
        for model in [
            "",
            " ",
            " gpt-transcribe",
            "gpt-transcribe ",
            "gpt transcribe",
            "gpt/transcribe",
            "gpt\\transcribe",
            "gpt\ntranscribe",
            "gpt\rtranscribe",
            "gpt\ttranscribe",
            "gpt\0transcribe",
            "gpt\u{7f}transcribe",
            "модель",
            "gpt-é",
            ".model",
            "_model",
            "-model",
            ":model",
            "model?",
            "model%",
            "model\"",
        ] {
            let settings = Settings {
                model: model.into(),
                ..Settings::default()
            };
            let error = settings.validate().unwrap_err();
            assert!(error.contains("идентификатор модели"));
            if !model.trim().is_empty() {
                assert!(!error.contains(model));
            }
        }
        let settings = Settings {
            model: "a".repeat(129),
            ..Settings::default()
        };
        assert!(settings.validate().is_err());
    }

    #[test]
    fn settings_limits() {
        let mut settings = Settings::default();
        settings.shortcut = " \t\n".into();
        assert!(settings.validate().is_err());
        settings.shortcut = "x".repeat(128);
        settings.input_device = Some("я".repeat(512));
        assert!(settings.validate().is_ok());
        settings.shortcut.push('x');
        assert!(settings.validate().is_err());
        settings.shortcut = "Super+R".into();
        settings.input_device.as_mut().unwrap().push('я');
        assert!(settings.validate().is_err());
    }

    #[test]
    fn statistics_accumulate_native_duration() {
        let mut statistics = Statistics::default();
        statistics.add_recording(1.25).unwrap();
        statistics.add_recording(2.5).unwrap();
        assert_eq!(statistics.last_recording_seconds, 2.5);
        assert_eq!(statistics.total_recording_seconds, 3.75);
        assert_eq!(statistics.recordings, 2);
        statistics.add_recording(601.0).unwrap();
    }

    #[test]
    fn invalid_durations_leave_statistics_unchanged() {
        let mut statistics = Statistics::default();
        statistics.add_recording(1.0).unwrap();
        for seconds in [0.0, -1.0, f64::NAN, f64::INFINITY, 601.01] {
            assert!(statistics.add_recording(seconds).is_err());
            assert_eq!(statistics.last_recording_seconds, 1.0);
            assert_eq!(statistics.total_recording_seconds, 1.0);
            assert_eq!(statistics.recordings, 1);
        }
        statistics.recordings = u64::MAX;
        assert!(statistics.add_recording(1.0).is_err());
        assert_eq!(statistics.total_recording_seconds, 1.0);
    }

    #[test]
    fn invalid_existing_statistics_are_rejected() {
        let mut statistics = Statistics {
            total_recording_seconds: f64::INFINITY,
            ..Statistics::default()
        };
        assert!(statistics.add_recording(1.0).is_err());
        assert_eq!(statistics.recordings, 0);
    }
}
