export type Phase = 'idle' | 'synthesizing' | 'playing' | 'recording' | 'transcribing' | 'polishing';

export interface PolishProfile {
  id: string;
  name: string;
  instruction: string;
}

export interface PolishSettings {
  profile_id: string | null;
  model: string;
  effort: string | null;
  custom_profiles: PolishProfile[];
}

export interface Settings {
  shortcut: string;
  model: string;
  tts_shortcut: string;
  tts_model: string;
  tts_voice: string;
  input_device: string | null;
  auto_paste: boolean;
  paste_shortcut: 'ctrl_v' | 'ctrl_shift_v';
  polish: PolishSettings;
}

export interface Statistics {
  last_recording_seconds: number;
  total_recording_seconds: number;
  recordings: number;
}

export interface Snapshot {
  phase: Phase;
  settings: Settings;
  statistics: Statistics;
  last_transcript: string | null;
  last_raw_transcript: string | null;
  can_retry_polish: boolean;
  builtin_polish_profiles: PolishProfile[];
  last_error: string | null;
  has_api_key: boolean;
  hotkey_available: boolean;
  hotkey_mode: 'native' | 'system';
  hotkey_command: string | null;
  hotkey_message: string | null;
  tts_hotkey_available: boolean;
  tts_hotkey_command: string | null;
  tts_hotkey_message: string | null;
  recording_seconds: number;
}

export interface InputDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export type Action =
  | 'save_settings'
  | 'set_api_key'
  | 'delete_api_key'
  | 'toggle_recording'
  | 'toggle_speech'
  | 'cancel_recording'
  | 'reset_statistics'
  | 'copy_last_transcript'
  | 'retry_polish'
  | 'quit_app';
