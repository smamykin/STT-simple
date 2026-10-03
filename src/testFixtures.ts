import type { Snapshot } from './types';

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    phase: 'idle',
    settings: {
      shortcut: 'Super+R', model: 'gpt-4o-mini-transcribe', input_device: null, auto_paste: false, paste_shortcut: 'ctrl_v',
      polish: { profile_id: null, model: 'gpt-6-luna', effort: null, custom_profiles: [] },
    },
    statistics: { last_recording_seconds: 0, total_recording_seconds: 0, recordings: 0 },
    last_transcript: null,
    last_raw_transcript: null,
    can_retry_polish: false,
    builtin_polish_profiles: [
      { id: 'polish', name: 'Минимальная правка', instruction: 'Минимально исправь текст, сохраняя смысл.' },
      { id: 'markdown', name: 'Markdown', instruction: 'Структурируй текст в Markdown.' },
      { id: 'developer', name: 'Сообщение разработчика', instruction: 'Оформи сообщение для мессенджера, сохраняя технические детали.' },
    ],
    last_error: null,
    has_api_key: true,
    hotkey_available: true,
    hotkey_mode: 'native',
    hotkey_command: null,
    hotkey_message: null,
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
