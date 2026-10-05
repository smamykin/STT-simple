import type { Snapshot } from './types';

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    phase: 'idle',
    settings: {
      shortcut: 'Super+R',
      model: 'gpt-4o-mini-transcribe',
      tts_shortcut: 'Control+Super+A',
      tts_model: 'gpt-4o-mini-tts',
      tts_voice: 'marin',
      input_device: null,
      auto_paste: false,
    },
    statistics: { last_recording_seconds: 0, total_recording_seconds: 0, recordings: 0 },
    last_transcript: null,
    last_error: null,
    has_api_key: true,
    hotkey_available: true,
    hotkey_mode: 'native',
    hotkey_command: null,
    hotkey_message: null,
    tts_hotkey_available: true,
    tts_hotkey_command: null,
    tts_hotkey_message: null,
    recording_seconds: 0,
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
