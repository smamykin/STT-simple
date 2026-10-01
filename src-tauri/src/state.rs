use crate::recorder::Recorder;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use stt_core::{OpenAiClient, Settings, Statistics, StoredData};
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    Recording,
    Transcribing,
    // Reserved for a later version; the MVP never enters this state.
    #[allow(dead_code)]
    Polishing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HotkeyMode {
    Native,
    System,
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub phase: Phase,
    pub settings: Settings,
    pub statistics: Statistics,
    pub last_transcript: Option<String>,
    pub last_error: Option<String>,
    pub has_api_key: bool,
    pub hotkey_available: bool,
    pub hotkey_mode: HotkeyMode,
    pub hotkey_command: Option<String>,
    pub hotkey_message: Option<String>,
    pub recording_seconds: f64,
}

pub struct Session {
    pub id: u64,
    pub recorder: Recorder,
    pub api_key: Zeroizing<String>,
    pub model: String,
    pub auto_paste: bool,
}

pub struct Data {
    pub stored: StoredData,
    pub phase: Phase,
    pub session: Option<Session>,
    pub next_session_id: u64,
    pub last_transcript: Option<String>,
    pub last_error: Option<String>,
    pub has_api_key: bool,
    pub hotkey_available: bool,
    pub hotkey_message: Option<String>,
    pub hotkey_mode: HotkeyMode,
    pub hotkey_command: Option<String>,
}

impl Data {
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            phase: self.phase,
            settings: self.stored.settings.clone(),
            statistics: self.stored.statistics.clone(),
            last_transcript: self.last_transcript.clone(),
            last_error: self.last_error.clone(),
            has_api_key: self.has_api_key,
            hotkey_available: self.hotkey_available,
            hotkey_mode: self.hotkey_mode,
            hotkey_command: self.hotkey_command.clone(),
            hotkey_message: self.hotkey_message.clone(),
            recording_seconds: self
                .session
                .as_ref()
                .map(|session| session.recorder.duration())
                .unwrap_or(0.0),
        }
    }

    pub fn ensure_idle(&self) -> Result<(), String> {
        if self.phase == Phase::Idle {
            Ok(())
        } else {
            Err("Сначала завершите запись или дождитесь распознавания.".into())
        }
    }
}

pub struct Runtime {
    pub data: Mutex<Data>,
    pub control: tokio::sync::Mutex<()>,
    pub clipboard: tokio::sync::Mutex<()>,
    pub shortcut_pressed: Mutex<bool>,
    pub client: OpenAiClient,
    pub storage_path: PathBuf,
}

impl Runtime {
    pub fn snapshot(&self) -> Snapshot {
        self.data
            .lock()
            .expect("application state poisoned")
            .snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idle_snapshot_contains_no_secrets_or_session_data() {
        let data = Data {
            stored: StoredData::default(),
            phase: Phase::Idle,
            session: None,
            next_session_id: 0,
            last_transcript: None,
            last_error: None,
            has_api_key: true,
            hotkey_available: false,
            hotkey_message: Some("System shortcut required".into()),
            hotkey_mode: HotkeyMode::System,
            hotkey_command: Some("stt-simple --toggle".into()),
        };
        let snapshot = data.snapshot();
        assert_eq!(snapshot.recording_seconds, 0.0);
        assert!(snapshot.has_api_key);
        assert!(!snapshot.hotkey_available);
        assert_eq!(snapshot.hotkey_mode, HotkeyMode::System);
        assert_eq!(
            snapshot.hotkey_command.as_deref(),
            Some("stt-simple --toggle")
        );
        assert!(snapshot.last_transcript.is_none());
        assert!(data.ensure_idle().is_ok());
    }
    #[test]
    fn busy_state_blocks_configuration_changes() {
        let data = Data {
            stored: StoredData::default(),
            phase: Phase::Transcribing,
            session: None,
            next_session_id: 0,
            last_transcript: None,
            last_error: None,
            has_api_key: true,
            hotkey_available: false,
            hotkey_message: None,
            hotkey_mode: HotkeyMode::Native,
            hotkey_command: None,
        };
        assert!(data.ensure_idle().is_err());
    }
}
