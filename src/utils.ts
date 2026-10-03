import type { Action, Phase, PolishProfile, Settings, Snapshot } from './types';

export const POLISH_MODELS = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'];
export const POLISH_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Documented capabilities; /models only supplies IDs and creation timestamps.
export const POLISH_MODEL_EFFORTS: Readonly<Record<string, readonly string[] | undefined>> = {
  'gpt-6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
};
export const BUILTIN_POLISH_IDS = ['polish', 'markdown', 'developer'];
export const MAX_CUSTOM_POLISH_PROFILES = 32;

export function createPolishProfileId(profiles: PolishProfile[]): string {
  const ids = new Set([...BUILTIN_POLISH_IDS, ...profiles.map((profile) => profile.id)]);
  let id: string;
  do { id = `custom-${crypto.randomUUID()}`; } while (ids.has(id));
  return id;
}

export const DEFAULT_MODEL = 'gpt-transcribe';
export const MODELS = [
  { value: DEFAULT_MODEL, label: 'GPT Transcribe — рекомендован OpenAI' },
  { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe' },
  { value: 'gpt-4o-mini-transcribe-2025-12-15', label: 'GPT-4o mini Transcribe — 2025-12-15' },
  { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
  { value: 'gpt-4o-transcribe-diarize', label: 'GPT-4o Transcribe Diarize — только текст' },
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
      return 'Обработка записи';
    case 'polishing':
      return 'Обработка текста';
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
    case 'retry_polish':
      return snapshot.phase === 'idle' && snapshot.has_api_key && snapshot.can_retry_polish;
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
    auto_paste: settings.auto_paste,
    paste_shortcut: settings.paste_shortcut,
    polish: {
      ...settings.polish,
      model: settings.polish.model.trim(),
      custom_profiles: settings.polish.custom_profiles.map((profile) => ({
        ...profile, name: profile.name.trim(), instruction: profile.instruction.trim(),
      })),
    },
  };
}

export function validateSettings(settings: Settings, builtinIds: readonly string[] = BUILTIN_POLISH_IDS): string | null {
  const polish = settings.polish;
  if (polish.model.trim() !== polish.model || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(polish.model)) {
    return 'Укажите корректный ID модели обработки текста: до 128 символов, без пробелов.';
  }
  if (polish.effort !== null && !POLISH_EFFORTS.includes(polish.effort)) {
    return 'Выберите допустимый уровень рассуждения.';
  }
  if (polish.custom_profiles.length > MAX_CUSTOM_POLISH_PROFILES) {
    return 'Можно сохранить не более 32 пользовательских профилей обработки.';
  }
  const ids = new Set([...BUILTIN_POLISH_IDS, ...builtinIds]);
  for (const profile of polish.custom_profiles) {
    if (profile.id.trim() !== profile.id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profile.id) || ids.has(profile.id)) {
      return 'ID пользовательских профилей должны быть уникальными и не совпадать со встроенными.';
    }
    if (!profile.name.trim() || !profile.instruction.trim()) {
      return 'У каждого пользовательского профиля должны быть название и инструкция.';
    }
    if ([...profile.name].length > 80 || [...profile.instruction].length > 8000) {
      return 'Название профиля — до 80 символов, инструкция — до 8000 символов.';
    }
    ids.add(profile.id);
  }
  if (polish.profile_id !== null && !ids.has(polish.profile_id)) {
    return 'Выберите существующий профиль обработки текста или выключите обработку.';
  }
  if (settings.model.trim() !== settings.model || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(settings.model)) {
    return 'Укажите ID модели OpenAI: до 128 символов, латинские буквы, цифры, точка, дефис, подчёркивание или двоеточие. Без пробелов.';
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
    && left.input_device === right.input_device
    && left.auto_paste === right.auto_paste
    && left.paste_shortcut === right.paste_shortcut
    && left.polish.profile_id === right.polish.profile_id
    && left.polish.model === right.polish.model
    && left.polish.effort === right.polish.effort
    && left.polish.custom_profiles.length === right.polish.custom_profiles.length
    && left.polish.custom_profiles.every((profile, index) => {
      const other = right.polish.custom_profiles[index];
      return other !== undefined && profile.id === other.id && profile.name === other.name && profile.instruction === other.instruction;
    });
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
