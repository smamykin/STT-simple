use crate::{player::Player, recorder::Recorder};
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use stt_core::{OpenAiClient, Settings, Statistics, StoredData};
use tauri_plugin_global_shortcut::Shortcut;
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    Synthesizing,
    Playing,
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
    pub tts_hotkey_available: bool,
    pub tts_hotkey_command: Option<String>,
    pub tts_hotkey_message: Option<String>,
    pub recording_seconds: f64,
}

pub struct Session {
    pub id: u64,
    pub recorder: Recorder,
    pub api_key: Zeroizing<String>,
    pub model: String,
    pub auto_paste: bool,
}

pub struct TtsSession {
    pub id: u64,
    pub cancel: tokio::sync::watch::Sender<bool>,
    pub preparation: Option<crate::player::Completion>,
    pub player: Option<Player>,
}

pub struct Data {
    pub tts_session: Option<TtsSession>,
    pub next_tts_session_id: u64,
    pub tts_hotkey_available: bool,
    pub tts_hotkey_command: Option<String>,
    pub tts_hotkey_message: Option<String>,
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
    pub fn tts_active(&self, id: u64) -> bool {
        matches!(self.phase, Phase::Synthesizing | Phase::Playing)
            && self.tts_session.as_ref().map(|session| session.id) == Some(id)
    }

    // Keep phase/session busy until the worker acknowledges resource release.
    pub fn request_tts_stop(
        &self,
        expected_id: Option<u64>,
    ) -> Option<(u64, Option<crate::player::Completion>)> {
        let session = self.tts_session.as_ref()?;
        if expected_id.is_some_and(|expected| session.id != expected) {
            return None;
        }
        let _ = session.cancel.send(true);
        let completion = session.player.as_ref().map(|player| {
            player.stop();
            player.completion()
        });
        Some((
            session.id,
            completion.or_else(|| session.preparation.clone()),
        ))
    }

    pub fn complete_tts(&mut self, id: u64, error: Option<String>) -> bool {
        if !self.tts_active(id) {
            return false;
        }
        let release_pending = self.tts_session.as_ref().is_some_and(|session| {
            session
                .player
                .as_ref()
                .is_some_and(|player| !player.is_complete())
                || session
                    .preparation
                    .as_ref()
                    .is_some_and(|completion| completion.borrow().is_none())
        });
        if release_pending {
            self.last_error = Some(error.unwrap_or_else(|| "Нет подтверждения освобождения аудиоустройства. Новая операция заблокирована; повторите остановку.".into()));
            return false;
        }
        self.stop_tts();
        self.last_error = error;
        true
    }

    // Only for acknowledged completion, synthesis without a player, or best-effort shutdown.
    pub fn stop_tts(&mut self) {
        if let Some(session) = self.tts_session.take() {
            let _ = session.cancel.send(true);
            if let Some(player) = session.player {
                player.stop();
            }
        }
        if matches!(self.phase, Phase::Synthesizing | Phase::Playing) {
            self.phase = Phase::Idle;
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            tts_hotkey_available: self.tts_hotkey_available,
            tts_hotkey_command: self.tts_hotkey_command.clone(),
            tts_hotkey_message: self.tts_hotkey_message.clone(),
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
            Err("Сначала завершите запись, распознавание или озвучивание.".into())
        }
    }
}

pub struct Runtime {
    pub data: Mutex<Data>,
    pub control: tokio::sync::Mutex<()>,
    pub clipboard: tokio::sync::Mutex<()>,
    pub shortcut_pressed: Mutex<HashSet<Shortcut>>,
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
    fn data() -> Data {
        Data {
            stored: StoredData::default(),
            phase: Phase::Idle,
            session: None,
            next_session_id: 0,
            tts_session: None,
            next_tts_session_id: 0,
            tts_hotkey_available: false,
            tts_hotkey_command: None,
            tts_hotkey_message: None,
            last_transcript: None,
            last_error: None,
            has_api_key: true,
            hotkey_available: false,
            hotkey_message: None,
            hotkey_mode: HotkeyMode::Native,
            hotkey_command: None,
        }
    }

    #[test]
    fn stopping_keeps_busy_until_ack_and_stale_completion_cannot_clear_new_session() {
        let mut data = data();
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        let (player, acknowledgement) = Player::pending_test_proxy();
        data.tts_session = Some(TtsSession {
            id: 42,
            cancel,
            preparation: None,
            player: Some(player),
        });
        data.phase = Phase::Playing;
        let (id, completion) = data.request_tts_stop(None).unwrap();
        assert_eq!(id, 42);
        assert!(completion.is_some());
        assert!(*receiver.borrow());
        assert!(data.phase == Phase::Playing);
        assert!(data.ensure_idle().is_err());
        assert!(!data.complete_tts(41, Some("stale error".into())));
        assert!(data.last_error.is_none());
        assert!(!data.complete_tts(42, None));
        assert!(data.phase == Phase::Playing);
        assert!(data.tts_session.is_some());
        acknowledgement.send(Some(Ok(()))).unwrap();
        assert!(data.complete_tts(42, None));
        assert!(data.phase == Phase::Idle);
        let (cancel, _) = tokio::sync::watch::channel(false);
        data.tts_session = Some(TtsSession {
            id: 43,
            cancel,
            preparation: None,
            player: None,
        });
        data.phase = Phase::Synthesizing;
        assert!(!data.complete_tts(42, Some("stale error".into())));
        assert!(data.last_error.is_none());
        assert!(data.tts_active(43));
        let (id, completion) = data.request_tts_stop(None).unwrap();
        assert_eq!(id, 43);
        assert!(completion.is_none());
        assert!(data.complete_tts(43, None));
        assert!(data.phase == Phase::Idle);
    }

    #[test]
    fn stale_play_error_cannot_stop_new_generation() {
        let mut data = data();
        let (cancel, cancellation) = tokio::sync::watch::channel(false);
        data.tts_session = Some(TtsSession {
            id: 43,
            cancel,
            preparation: None,
            player: None,
        });
        data.phase = Phase::Synthesizing;

        assert!(data.request_tts_stop(Some(42)).is_none());
        assert!(!*cancellation.borrow());
        assert!(data.tts_active(43));
        assert!(!data.complete_tts(42, Some("stale play error".into())));
        assert!(data.last_error.is_none());
        assert!(!*cancellation.borrow());
        assert!(data.tts_active(43));
    }

    #[test]
    fn preparation_stop_keeps_session_busy_until_acknowledged() {
        let mut data = data();
        let (cancel, cancellation) = tokio::sync::watch::channel(false);
        let (acknowledgement, completion) = tokio::sync::watch::channel(None);
        data.tts_session = Some(TtsSession {
            id: 42,
            cancel,
            preparation: Some(completion),
            player: None,
        });
        data.phase = Phase::Synthesizing;

        let (id, completion) = data.request_tts_stop(None).unwrap();
        assert_eq!(id, 42);
        assert!(completion.is_some());
        assert!(*cancellation.borrow());
        assert!(!data.complete_tts(42, None));
        assert!(data.phase == Phase::Synthesizing);

        acknowledgement.send(Some(Ok(()))).unwrap();
        assert!(data.complete_tts(42, None));
        assert!(data.phase == Phase::Idle);
    }

    #[test]
    fn tts_session_is_generation_and_phase_scoped_and_stop_cancels() {
        let mut data = data();
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        data.tts_session = Some(TtsSession {
            id: 42,
            cancel,
            preparation: None,
            player: None,
        });
        for phase in [Phase::Synthesizing, Phase::Playing] {
            data.phase = phase;
            assert!(data.tts_active(42));
            assert!(!data.tts_active(41));
            assert!(data.ensure_idle().is_err());
        }
        for phase in [Phase::Recording, Phase::Transcribing, Phase::Polishing] {
            data.phase = phase;
            assert!(!data.tts_active(42));
            assert!(data.ensure_idle().is_err());
        }
        data.phase = Phase::Playing;
        data.stop_tts();
        assert!(*receiver.borrow());
        assert!(data.phase == Phase::Idle);
        assert!(data.tts_session.is_none());
        assert!(data.ensure_idle().is_ok());
        let (cancel, _) = tokio::sync::watch::channel(false);
        data.tts_session = Some(TtsSession {
            id: 43,
            cancel,
            preparation: None,
            player: None,
        });
        data.phase = Phase::Synthesizing;
        assert!(!data.tts_active(42));
        assert!(data.tts_active(43));
    }

    #[test]
    fn all_phases_serialize_only_public_snapshot_fields() {
        use tauri::ipc::{InvokeResponseBody, IpcResponse};
        let mut data = data();
        let (cancel, _) = tokio::sync::watch::channel(false);
        data.tts_session = Some(TtsSession {
            id: 987654321,
            cancel,
            preparation: None,
            player: None,
        });
        for (phase, name) in [
            (Phase::Idle, "idle"),
            (Phase::Recording, "recording"),
            (Phase::Transcribing, "transcribing"),
            (Phase::Polishing, "polishing"),
            (Phase::Synthesizing, "synthesizing"),
            (Phase::Playing, "playing"),
        ] {
            data.phase = phase;
            let InvokeResponseBody::Json(json) = data.snapshot().body().unwrap() else {
                panic!("expected JSON");
            };
            assert!(json.contains(&format!("\"phase\":\"{name}\"")));
            for secret in [
                "tts_session",
                "987654321",
                "\"api_key\":",
                "clipboard",
                "wav",
                "cancel",
                "player",
                "next_tts_session_id",
            ] {
                assert!(!json.contains(secret), "unexpected runtime field: {secret}");
            }
            assert!(json.contains("tts_hotkey_available"));
        }
    }

    #[test]
    fn idle_snapshot_contains_no_secrets_or_session_data() {
        let data = Data {
            tts_session: None,
            next_tts_session_id: 0,
            tts_hotkey_available: false,
            tts_hotkey_command: None,
            tts_hotkey_message: None,
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
            tts_session: None,
            next_tts_session_id: 0,
            tts_hotkey_available: false,
            tts_hotkey_command: None,
            tts_hotkey_message: None,
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
