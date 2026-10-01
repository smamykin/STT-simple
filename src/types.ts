export type Phase = 'idle' | 'recording' | 'transcribing' | 'polishing';

export interface Settings {
  shortcut: string;
  model: string;
  input_device: string | null;
  auto_paste: boolean;
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
  last_error: string | null;
  has_api_key: boolean;
  hotkey_available: boolean;
  hotkey_mode: 'native' | 'system';
  hotkey_command: string | null;
  hotkey_message: string | null;
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
  | 'cancel_recording'
  | 'reset_statistics'
  | 'copy_last_transcript'
  | 'quit_app';
