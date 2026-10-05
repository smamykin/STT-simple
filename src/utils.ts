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
export const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_TTS_VOICE = 'marin';

export const MODELS = [
  { value: DEFAULT_MODEL, label: 'GPT Transcribe — рекомендован OpenAI' },
  { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe' },
  { value: 'gpt-4o-mini-transcribe-2025-12-15', label: 'GPT-4o mini Transcribe — 2025-12-15' },
  { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
  { value: 'gpt-4o-transcribe-diarize', label: 'GPT-4o Transcribe Diarize — только текст' },
  { value: 'whisper-1', label: 'Whisper 1' },
] as const;

export const TTS_MODELS = [
  { value: DEFAULT_TTS_MODEL, label: 'GPT-4o mini TTS — рекомендован OpenAI' },
] as const;

// Known built-in Speech API voices. Availability still depends on the selected model and account.
export const TTS_VOICES = [
  { value: 'marin', label: 'Marin — рекомендован OpenAI' },
  { value: 'cedar', label: 'Cedar — рекомендован OpenAI' },
  { value: 'alloy', label: 'Alloy' },
  { value: 'ash', label: 'Ash' },
  { value: 'ballad', label: 'Ballad' },
  { value: 'coral', label: 'Coral' },
  { value: 'echo', label: 'Echo' },
  { value: 'fable', label: 'Fable' },
  { value: 'nova', label: 'Nova' },
  { value: 'onyx', label: 'Onyx' },
  { value: 'sage', label: 'Sage' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'verse', label: 'Verse' },
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
    case 'synthesizing':
      return 'Создаём речь';
    case 'playing':
      return 'Воспроизводим речь';
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
        || ((snapshot.phase === 'idle' || snapshot.phase === 'synthesizing' || snapshot.phase === 'playing')
          && snapshot.has_api_key);
    case 'toggle_speech':
      return snapshot.phase === 'synthesizing' || snapshot.phase === 'playing'
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

const MODIFIER_ALIASES: Record<string, string> = {
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  super: 'super',
  meta: 'super',
  command: 'super',
  cmd: 'super',
};
const MODIFIERS = new Set(Object.keys(MODIFIER_ALIASES));
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function normalizeShortcut(shortcut: string): string {
  return shortcut.split('+').map((part) => part.trim()).join('+');
}

function shortcutIdentity(shortcut: string): string | null {
  const parts = shortcut.split('+').map((part) => part.trim().toLowerCase());
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1).map((modifier) => MODIFIER_ALIASES[modifier]);
  if (parts.some((part) => !part) || !key || MODIFIERS.has(key)
    || modifiers.length === 0 || modifiers.some((modifier) => !modifier)) return null;
  return `${[...modifiers].sort().join('+')}+${key}`;
}

export function formatShortcutHint(shortcut: string, mac: boolean): string {
  if (!mac) return shortcut;
  const names: Record<string, string> = {
    control: 'Ctrl',
    ctrl: 'Ctrl',
    super: 'Cmd',
    meta: 'Cmd',
    command: 'Cmd',
    cmd: 'Cmd',
    alt: 'Option',
    option: 'Option',
    shift: 'Shift',
  };
  return shortcut.split('+').map((part) => names[part.trim().toLowerCase()] ?? part.trim()).join('+');
}

export function normalizeSettings(settings: Settings): Settings {
  return {
    shortcut: normalizeShortcut(settings.shortcut),
    model: settings.model.trim(),
    tts_shortcut: normalizeShortcut(settings.tts_shortcut),
    tts_model: settings.tts_model.trim(),
    tts_voice: settings.tts_voice.trim(),
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


function validateShortcut(shortcut: string, purpose: 'распознавания' | 'озвучивания'): string | null {
  const value = shortcut.trim();
  if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    return `Укажите сочетание клавиш ${purpose}, например Super+R или Control+Super+R.`;
  }
  const parts = value.split('+').map((part) => part.trim().toLowerCase());
  const modifiers = parts.slice(0, -1);
  if (!shortcutIdentity(value) || new Set(modifiers.map((modifier) => MODIFIER_ALIASES[modifier])).size !== modifiers.length) {
    return 'Используйте модификатор и одну клавишу, например Super+R. Не повторяйте модификаторы.';
  }
  return null;
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
  if (settings.model.trim() !== settings.model || !ID_PATTERN.test(settings.model)) {
    return 'Укажите ID модели OpenAI: до 128 символов, латинские буквы, цифры, точка, дефис, подчёркивание или двоеточие. Без пробелов.';
  }
  if (settings.tts_model.trim() !== settings.tts_model || !ID_PATTERN.test(settings.tts_model)) {
    return 'Укажите ID TTS-модели OpenAI: до 128 символов, латинские буквы, цифры, точка, дефис, подчёркивание или двоеточие. Без пробелов.';
  }
  if (settings.tts_voice.trim() !== settings.tts_voice || !ID_PATTERN.test(settings.tts_voice)) {
    return 'Укажите ID голоса OpenAI: до 128 символов, латинские буквы, цифры, точка, дефис, подчёркивание или двоеточие. Без пробелов.';
  }
  if (settings.input_device !== null && !settings.input_device.trim()) {
    return 'Выберите микрофон или системное устройство по умолчанию.';
  }
  const sttShortcutError = validateShortcut(settings.shortcut, 'распознавания');
  if (sttShortcutError) return sttShortcutError;
  const ttsShortcutError = validateShortcut(settings.tts_shortcut, 'озвучивания');
  if (ttsShortcutError) return ttsShortcutError;
  if (shortcutIdentity(settings.shortcut) === shortcutIdentity(settings.tts_shortcut)) {
    return 'Сочетания клавиш распознавания и озвучивания не должны совпадать.';
  }
  // The backend is authoritative for platform-specific shortcut parsing.
  return null;
}

export function settingsEqual(left: Settings, right: Settings): boolean {
  return left.shortcut === right.shortcut
    && left.model === right.model
    && left.tts_shortcut === right.tts_shortcut
    && left.tts_model === right.tts_model
    && left.tts_voice === right.tts_voice
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
