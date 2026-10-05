import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { InputDevice, Settings, Snapshot } from './types';

export const inTauri = isTauri();

export const backend = {
  getSnapshot: () => invoke<Snapshot>('get_snapshot'),
  listInputDevices: () => invoke<InputDevice[]>('list_input_devices'),
  saveSettings: (settings: Settings) => invoke<Snapshot>('save_settings', { settings }),
  setApiKey: (apiKey: string) => invoke<Snapshot>('set_api_key', { apiKey }),
  deleteApiKey: () => invoke<Snapshot>('delete_api_key'),
  toggleRecording: () => invoke<void>('toggle_recording'),
  toggleSpeech: () => invoke<void>('toggle_speech'),
  cancelRecording: () => invoke<void>('cancel_recording'),
  resetStatistics: () => invoke<Snapshot>('reset_statistics'),
  copyLastTranscript: () => invoke<void>('copy_last_transcript'),
  quitApp: () => invoke<void>('quit_app'),
  subscribe: (onSnapshot: (snapshot: Snapshot) => void) =>
    listen<Snapshot>('app-state', (event) => onSnapshot(event.payload)),
};
