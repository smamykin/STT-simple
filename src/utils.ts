import type { Action, Phase, Settings, Snapshot } from './types';

export const MODELS = [
  { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe' },
  { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
  { value: 'whisper-1', label: 'Whisper 1' },
] as const;

export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remaining = safe % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(remaining)}`
    : `${pad(minutes)}:${pad(remaining)}`;
}

export function isBusy(phase: Phase): boolean {
  return phase !== 'idle';
}

export function statusText(phase: Phase): string {
  switch (phase) {
    case 'idle':
      return 'Готово к диктовке';
    case 'recording':
      return 'Идёт запись';
    case 'transcribing':
    case 'polishing':
      // The reserved phase is treated as busy, without offering a polishing feature.
      return 'Обработка записи';
  }
}

export function canRunAction(action: Action, snapshot: Snapshot | null): boolean {
  if (!snapshot) return false;
  switch (action) {
    case 'toggle_recording':
      return snapshot.phase === 'recording'
        || (snapshot.phase === 'idle' && snapshot.has_api_key);
    case 'cancel_recording':
      return snapshot.phase === 'recording';
    case 'copy_last_transcript':
      return snapshot.phase === 'idle' && Boolean(snapshot.last_transcript);
    default:
      return !isBusy(snapshot.phase);
  }
}

const MODIFIERS = new Set([
  'control', 'ctrl', 'alt', 'option', 'shift', 'super', 'meta', 'command', 'cmd',
]);

export function normalizeSettings(settings: Settings): Settings {
  return {
    shortcut: settings.shortcut.split('+').map((part) => part.trim()).join('+'),
    model: settings.model.trim(),
    input_device: settings.input_device,
  };
}

export function validateSettings(settings: Settings): string | null {
  if (!MODELS.some((model) => model.value === settings.model)) {
    return 'Выберите одну из доступных моделей распознавания.';
  }
  if (settings.input_device !== null && !settings.input_device.trim()) {
    return 'Выберите микрофон или системное устройство по умолчанию.';
  }
  const shortcut = settings.shortcut.trim();
  if (!shortcut || shortcut.length > 128 || /[\u0000-\u001f\u007f]/.test(shortcut)) {
    return 'Укажите сочетание клавиш, например Super+R или Control+Super+R.';
  }
  const parts = shortcut.split('+').map((part) => part.trim().toLowerCase());
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (parts.some((part) => !part) || !key || MODIFIERS.has(key)
    || modifiers.length === 0 || modifiers.some((part) => !MODIFIERS.has(part))
    || new Set(modifiers).size !== modifiers.length) {
    return 'Используйте модификатор и одну клавишу, например Super+R. Не повторяйте модификаторы.';
  }
  // The backend is authoritative for platform-specific shortcut parsing.
  return null;
}

export function settingsEqual(left: Settings, right: Settings): boolean {
  return left.shortcut === right.shortcut
    && left.model === right.model
    && left.input_device === right.input_device;
}

export function validateApiKey(key: string): string | null {
  if (!key.trim()) return 'Введите API-ключ OpenAI.';
  if (key.trim().length > 1024 || /\s/.test(key.trim())) {
    return 'В API-ключе не должно быть пробелов или переносов строк. Скопируйте ключ целиком.';
  }
  return null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (typeof error === 'object' && error !== null && 'message' in error
    && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return 'Неизвестная ошибка. Повторите действие; если ошибка остаётся, перезапустите приложение.';
}
