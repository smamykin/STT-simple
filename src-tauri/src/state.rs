use crate::recorder::Recorder;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use stt_core::{OpenAiClient, PolishProfile, PolishSettings, Settings, Statistics, StoredData};
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    Recording,
    Transcribing,
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
    pub last_raw_transcript: Option<String>,
    pub can_retry_polish: bool,
    pub builtin_polish_profiles: Vec<PolishProfile>,
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
    pub polish: PolishSettings,
    pub auto_paste: bool,
    pub paste_shortcut: stt_core::PasteShortcut,
}

pub struct Data {
    pub stored: StoredData,
    pub phase: Phase,
    pub session: Option<Session>,
    pub next_session_id: u64,
    pub last_transcript: Option<String>,
    pub last_raw_transcript: Option<String>,
    pub pending_polish: Option<PolishSettings>,
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
            last_raw_transcript: self.last_raw_transcript.clone(),
            can_retry_polish: self.phase == Phase::Idle
                && self.pending_polish.is_some()
                && self.last_raw_transcript.is_some(),
            builtin_polish_profiles: stt_core::builtin_polish_profiles(),
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

    // Invalidate retry only after the microphone starts successfully.
    pub fn recording_started(&mut self) {
        self.pending_polish = None;
        self.last_raw_transcript = None;
        self.last_error = None;
        self.phase = Phase::Recording;
    }

    pub fn accept_transcript(
        &mut self,
        raw: String,
        polish: PolishSettings,
    ) -> Result<bool, String> {
        self.last_raw_transcript = Some(raw);
        self.last_transcript = None;
        self.pending_polish = None;
        if polish.profile_id.is_none() {
            return Ok(false);
        }
        self.pending_polish = Some(polish.clone());
        self.phase = Phase::Polishing;
        polish.selected_profile()?;
        Ok(true)
    }

    pub fn retry_job(&self) -> Result<(String, PolishSettings), String> {
        self.ensure_idle()?;
        match (&self.last_raw_transcript, &self.pending_polish) {
            (Some(raw), Some(settings)) => Ok((raw.clone(), settings.clone())),
            _ => Err("Нет неудачной обработки для повторной попытки.".into()),
        }
    }

    pub fn begin_retry(&mut self) -> Result<(String, PolishSettings), String> {
        let job = self.retry_job()?;
        self.phase = Phase::Polishing;
        self.last_error = None;
        Ok(job)
    }

    pub fn accept_output(&mut self, text: String) {
        self.last_transcript = Some(text);
        self.pending_polish = None;
    }

    pub fn update_warning(&mut self, warning: Option<String>) {
        if self.pending_polish.is_none() {
            self.last_error = warning;
        } else if let Some(warning) = warning {
            self.last_error = Some(match self.last_error.take() {
                Some(previous) if previous != warning => format!("{previous}\n{warning}"),
                _ => warning,
            });
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

    fn idle_data() -> Data {
        Data {
            stored: StoredData::default(),
            phase: Phase::Idle,
            session: None,
            next_session_id: 0,
            last_transcript: None,
            last_raw_transcript: None,
            pending_polish: None,
            last_error: None,
            has_api_key: true,
            hotkey_available: false,
            hotkey_message: None,
            hotkey_mode: HotkeyMode::Native,
            hotkey_command: None,
        }
    }

    fn selected_polish() -> PolishSettings {
        PolishSettings {
            profile_id: Some("custom-test".into()),
            model: "gpt-5-mini".into(),
            effort: Some("low".into()),
            custom_profiles: vec![PolishProfile {
                id: "custom-test".into(),
                name: "Test".into(),
                instruction: "Preserve all details.".into(),
            }],
        }
    }

    fn failed_polish() -> Data {
        let mut data = idle_data();
        data.phase = Phase::Transcribing;
        assert!(data
            .accept_transcript("raw".into(), selected_polish())
            .unwrap());
        data.phase = Phase::Idle;
        data.last_error = Some("polish failed".into());
        data
    }

    #[test]
    fn disabled_polish_keeps_raw_and_only_publishes_successful_output() {
        let mut data = idle_data();
        data.phase = Phase::Transcribing;
        data.last_transcript = Some("old output".into());
        assert!(!data
            .accept_transcript("raw".into(), PolishSettings::default())
            .unwrap());
        assert!(data.last_transcript.is_none());
        assert_eq!(data.last_raw_transcript.as_deref(), Some("raw"));
        data.accept_output("raw".into());
        data.phase = Phase::Idle;
        assert_eq!(data.snapshot().last_transcript.as_deref(), Some("raw"));
        assert!(!data.snapshot().can_retry_polish);
    }

    #[test]
    fn selected_polish_clears_stale_output_and_blocks_commands_until_completion() {
        let mut data = idle_data();
        data.last_transcript = Some("old output".into());
        assert!(data
            .accept_transcript("raw".into(), selected_polish())
            .unwrap());
        assert!(data.phase == Phase::Polishing);
        assert!(data.last_transcript.is_none());
        assert!(data.ensure_idle().is_err());
        assert!(data.begin_retry().is_err());
        assert!(!data.snapshot().can_retry_polish);
        data.accept_output("edited".into());
        data.phase = Phase::Idle;
        assert_eq!(data.last_raw_transcript.as_deref(), Some("raw"));
        assert_eq!(data.last_transcript.as_deref(), Some("edited"));
        assert!(data.retry_job().is_err());
    }

    #[test]
    fn retry_uses_captured_configuration_and_does_not_change_statistics_or_settings() {
        let mut data = failed_polish();
        data.stored.settings.polish = PolishSettings::default();
        data.stored.statistics.add_recording(12.0).unwrap();
        let stored_before = data.stored.clone();
        assert!(data.snapshot().can_retry_polish);
        let (raw, settings) = data.begin_retry().unwrap();
        assert_eq!(raw, "raw");
        assert_eq!(settings, selected_polish());
        assert!(data.last_error.is_none());
        assert!(data.phase == Phase::Polishing);
        assert!(data.begin_retry().is_err());
        data.accept_output("edited".into());
        data.phase = Phase::Idle;
        assert!(!data.snapshot().can_retry_polish);
        assert_eq!(data.stored.settings.polish, stored_before.settings.polish);
        assert_eq!(
            data.stored.statistics.recordings,
            stored_before.statistics.recordings
        );
        assert_eq!(
            data.stored.statistics.last_recording_seconds,
            stored_before.statistics.last_recording_seconds
        );
        assert_eq!(
            data.stored.statistics.total_recording_seconds,
            stored_before.statistics.total_recording_seconds
        );
    }

    #[test]
    fn repeated_failure_retains_job_and_configuration_changes_preserve_error() {
        let mut data = failed_polish();
        data.update_warning(None);
        assert_eq!(data.last_error.as_deref(), Some("polish failed"));
        data.update_warning(Some("storage warning".into()));
        assert_eq!(
            data.last_error.as_deref(),
            Some("polish failed\nstorage warning")
        );
        data.begin_retry().unwrap();
        data.phase = Phase::Idle;
        data.last_error = Some("failed again".into());
        assert_eq!(data.retry_job().unwrap(), ("raw".into(), selected_polish()));
        assert!(data.last_transcript.is_none());
    }

    #[test]
    fn new_recording_invalidates_retry_but_failed_start_does_not() {
        let mut data = failed_polish();
        data.update_warning(Some("microphone unavailable".into()));
        assert!(data.snapshot().can_retry_polish);
        data.recording_started();
        assert!(data.pending_polish.is_none());
        assert!(data.last_raw_transcript.is_none());
        assert!(data.last_error.is_none());
        // Cancelling the new recording must not revive the old failed job.
        data.phase = Phase::Idle;
        assert!(data.retry_job().is_err());
    }

    #[test]
    fn retry_guards_leave_state_unchanged() {
        let mut data = idle_data();
        data.last_error = Some("unrelated error".into());
        assert!(data.begin_retry().is_err());
        assert_eq!(data.last_error.as_deref(), Some("unrelated error"));
        for phase in [Phase::Recording, Phase::Transcribing, Phase::Polishing] {
            let mut data = failed_polish();
            data.phase = phase;
            assert!(data.begin_retry().is_err());
            assert!(data.phase == phase);
            assert_eq!(data.last_error.as_deref(), Some("polish failed"));
            assert!(data.pending_polish.is_some());
        }
    }

    #[test]
    fn invalid_selected_profile_retains_raw_without_publishing_output() {
        let mut data = idle_data();
        data.last_transcript = Some("old".into());
        let settings = PolishSettings {
            profile_id: Some("missing".into()),
            ..Default::default()
        };
        assert!(data.accept_transcript("raw".into(), settings).is_err());
        data.phase = Phase::Idle;
        assert_eq!(data.last_raw_transcript.as_deref(), Some("raw"));
        assert!(data.last_transcript.is_none());
        assert!(data.snapshot().can_retry_polish);
        assert_eq!(
            data.snapshot().builtin_polish_profiles,
            stt_core::builtin_polish_profiles()
        );
    }
    #[test]
    fn idle_snapshot_contains_no_secrets_or_session_data() {
        let data = Data {
            stored: StoredData::default(),
            phase: Phase::Idle,
            session: None,
            next_session_id: 0,
            last_transcript: None,
            last_raw_transcript: None,
            pending_polish: None,
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
            last_raw_transcript: None,
            pending_polish: None,
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
