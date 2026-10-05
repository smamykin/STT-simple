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
pub const DEFAULT_TTS_MODEL: &str = "gpt-4o-mini-tts";
pub const DEFAULT_TTS_VOICE: &str = "marin";
pub const MAX_TTS_INPUT_CHARS: usize = 4096;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub shortcut: String,
    pub model: String,
    pub tts_shortcut: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub input_device: Option<String>,
    pub auto_paste: bool,
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
            tts_shortcut: "Control+Super+A".to_owned(),
            tts_model: DEFAULT_TTS_MODEL.to_owned(),
            tts_voice: DEFAULT_TTS_VOICE.to_owned(),
            input_device: None,
            auto_paste: false,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        validate_model(&self.model)?;
        validate_model(&self.tts_model)
            .map_err(|_| "Некорректный идентификатор TTS-модели. Используйте от 1 до 128 ASCII-символов: первая буква или цифра, далее буквы, цифры и . _ - : без пробелов.".to_owned())?;
        validate_voice(&self.tts_voice)?;
        validate_shortcut(
            &self.shortcut,
            "Укажите сочетание клавиш распознавания длиной от 1 до 128 символов.",
        )?;
        validate_shortcut(
            &self.tts_shortcut,
            "Укажите сочетание клавиш озвучивания длиной от 1 до 128 символов.",
        )?;
        if shortcuts_are_equivalent(&self.shortcut, &self.tts_shortcut) {
            return Err("Сочетания клавиш распознавания и озвучивания не должны совпадать.".into());
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

fn validate_shortcut(shortcut: &str, error: &str) -> Result<(), String> {
    if shortcut.trim().is_empty() || shortcut.chars().count() > 128 {
        return Err(error.into());
    }
    Ok(())
}

pub(crate) fn shortcuts_are_equivalent(left: &str, right: &str) -> bool {
    if left.trim() == right.trim() {
        return true;
    }
    match (shortcut_identity(left), shortcut_identity(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn shortcut_identity(shortcut: &str) -> Option<(u8, String)> {
    let mut parts = shortcut.trim().split('+').peekable();
    let mut modifiers = 0;
    let mut key = None;

    while let Some(part) = parts.next() {
        if part.is_empty() || !part.is_ascii() || key.is_some() {
            return None;
        }
        if let Some(modifier) = shortcut_modifier(part) {
            if parts.peek().is_none() || modifiers & modifier != 0 {
                return None;
            }
            modifiers |= modifier;
        } else {
            if parts.peek().is_some() || !part.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
                return None;
            }
            key = Some(part.to_ascii_lowercase());
        }
    }

    key.map(|key| (modifiers, key))
}

fn shortcut_modifier(part: &str) -> Option<u8> {
    if part.eq_ignore_ascii_case("control") || part.eq_ignore_ascii_case("ctrl") {
        Some(1 << 0)
    } else if part.eq_ignore_ascii_case("alt") || part.eq_ignore_ascii_case("option") {
        Some(1 << 1)
    } else if part.eq_ignore_ascii_case("super")
        || part.eq_ignore_ascii_case("meta")
        || part.eq_ignore_ascii_case("command")
        || part.eq_ignore_ascii_case("cmd")
    {
        Some(1 << 2)
    } else if part.eq_ignore_ascii_case("shift") {
        Some(1 << 3)
    } else {
        None
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

pub(crate) fn validate_voice(voice: &str) -> Result<(), String> {
    let bytes = voice.as_bytes();
    if !(1..=128).contains(&bytes.len())
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        return Err("Некорректный идентификатор голоса. Используйте от 1 до 128 ASCII-символов: первая буква или цифра, далее буквы, цифры и . _ - : без пробелов.".into());
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
        assert_eq!(DEFAULT_TTS_MODEL, "gpt-4o-mini-tts");
        assert_eq!(DEFAULT_TTS_VOICE, "marin");
        assert_eq!(MAX_TTS_INPUT_CHARS, 4096);
        assert_eq!(settings.tts_shortcut, "Control+Super+A");
        assert_eq!(settings.tts_model, DEFAULT_TTS_MODEL);
        assert_eq!(settings.tts_voice, DEFAULT_TTS_VOICE);
        assert_eq!(settings.input_device, None);
        assert!(!settings.auto_paste);
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
        settings.tts_shortcut = "y".repeat(128);
        settings.input_device = Some("я".repeat(512));
        assert!(settings.validate().is_ok());
        settings.shortcut.push('x');
        assert!(settings.validate().is_err());
        settings.shortcut = "Super+R".into();
        settings.input_device.as_mut().unwrap().push('я');
        assert!(settings.validate().is_err());
    }

    #[test]
    fn serde_defaults_tts_fields_for_existing_settings() {
        let settings: Settings =
            serde_json::from_str(r#"{"shortcut":"Super+R","model":"whisper-1"}"#).unwrap();
        assert_eq!(settings.tts_shortcut, "Control+Super+A");
        assert_eq!(settings.tts_model, DEFAULT_TTS_MODEL);
        assert_eq!(settings.tts_voice, DEFAULT_TTS_VOICE);
    }

    #[test]
    fn tts_settings_validation() {
        let mut settings = Settings::default();
        settings.tts_shortcut = " ".into();
        assert!(settings.validate().unwrap_err().contains("озвучивания"));
        settings.tts_shortcut = "x".repeat(129);
        assert!(settings.validate().unwrap_err().contains("озвучивания"));
        settings.tts_shortcut = "Control+Super+A".into();
        settings.tts_model = "bad/model".into();
        assert!(settings.validate().unwrap_err().contains("TTS-модели"));
        settings.tts_model = DEFAULT_TTS_MODEL.into();
        settings.tts_voice = "bad voice".into();
        assert!(settings.validate().unwrap_err().contains("голоса"));
        settings.tts_voice = "я".into();
        assert!(settings.validate().unwrap_err().contains("голоса"));
        settings.tts_voice = "voice_1.0:preview".into();
        settings.shortcut = "  Control+Super+A  ".into();
        assert!(settings
            .validate()
            .unwrap_err()
            .contains("не должны совпадать"));
    }

    #[test]
    fn equivalent_shortcuts_use_modifier_order_case_and_aliases() {
        let settings = Settings {
            shortcut: "sUpEr+cTrL+a".into(),
            tts_shortcut: "CONTROL+command+A".into(),
            ..Settings::default()
        };
        assert!(settings
            .validate()
            .unwrap_err()
            .contains("не должны совпадать"));
    }

    #[test]
    fn malformed_shortcuts_have_no_canonical_identity() {
        for malformed in [
            "Control+Ctrl+A",
            "Super+Command+A",
            "Control++A",
            "Control+A+Shift",
            "Control+Key A",
        ] {
            assert_eq!(shortcut_identity(malformed), None, "{malformed}");
        }
    }

    #[test]
    fn trimmed_identical_malformed_shortcuts_remain_conflicting() {
        let settings = Settings {
            shortcut: "Control++A".into(),
            tts_shortcut: "  Control++A  ".into(),
            ..Settings::default()
        };
        assert!(settings
            .validate()
            .unwrap_err()
            .contains("не должны совпадать"));
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
