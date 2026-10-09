import { describe, expect, it } from 'vitest';
import { makeSnapshot } from './testFixtures';
import type { Action, Settings } from './types';
import {
  MODELS, TTS_MODELS, TTS_VOICES, canRunAction, createPolishProfileId, errorMessage, formatDuration,
  formatShortcutHint, isBusy, normalizeSettings, settingsEqual, statusText, validateApiKey, validateSettings,
} from './utils';

const settings: Settings = {
  ...makeSnapshot().settings,
};

const configurationActions: Action[] = [
  'save_settings', 'set_api_key', 'delete_api_key', 'reset_statistics', 'quit_app',
];

const sttPhases = ['recording', 'transcribing', 'polishing'] as const;
const ttsPhases = ['synthesizing', 'playing'] as const;

describe('formatDuration', () => {
  it.each([
    { seconds: 0, expected: '00:00' },
    { seconds: 5.9, expected: '00:05' },
    { seconds: 65, expected: '01:05' },
    { seconds: 3599, expected: '59:59' },
    { seconds: 3600, expected: '01:00:00' },
    { seconds: 3661, expected: '01:01:01' },
    { seconds: 360000, expected: '100:00:00' },
    { seconds: -10, expected: '00:00' },
    { seconds: NaN, expected: '00:00' },
    { seconds: Infinity, expected: '00:00' },
  ])('formats $seconds as $expected', ({ seconds, expected }) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('status and action guards', () => {
  it('requires a key to start but not to stop an existing recording', () => {
    expect(canRunAction('toggle_recording', makeSnapshot({ has_api_key: false }))).toBe(false);
    expect(canRunAction('toggle_recording', makeSnapshot())).toBe(true);
    expect(canRunAction('toggle_recording', makeSnapshot({ phase: 'recording', has_api_key: false }))).toBe(true);
  });

  it.each(ttsPhases)('allows recording to interrupt %s only when a key is present', (phase) => {
    expect(canRunAction('toggle_recording', makeSnapshot({ phase, has_api_key: true }))).toBe(true);
    expect(canRunAction('toggle_recording', makeSnapshot({ phase, has_api_key: false }))).toBe(false);
  });

  it('starts speech only while idle with a key', () => {
    expect(canRunAction('toggle_speech', makeSnapshot())).toBe(true);
    expect(canRunAction('toggle_speech', makeSnapshot({ has_api_key: false }))).toBe(false);
  });

  it.each(ttsPhases)('stops speech during %s even when the key is missing', (phase) => {
    expect(canRunAction('toggle_speech', makeSnapshot({ phase, has_api_key: false }))).toBe(true);
  });

  it.each(sttPhases)('rejects speech during %s', (phase) => {
    expect(canRunAction('toggle_speech', makeSnapshot({ phase }))).toBe(false);
  });

  it('does not enable actions without an initial snapshot', () => {
    for (const action of [...configurationActions, 'toggle_recording', 'toggle_speech', 'cancel_recording', 'copy_last_transcript', 'retry_polish'] as Action[]) {
      expect(canRunAction(action, null)).toBe(false);
    }
  });

  it.each([...sttPhases, ...ttsPhases])('locks settings, key and statistics during %s', (phase) => {
    expect(isBusy(phase)).toBe(true);
    for (const action of configurationActions) {
      expect(canRunAction(action, makeSnapshot({ phase }))).toBe(false);
    }
  });

  it('allows cancellation only during recording', () => {
    expect(canRunAction('cancel_recording', makeSnapshot({ phase: 'recording' }))).toBe(true);
    for (const phase of ['idle', 'transcribing', 'polishing', 'synthesizing', 'playing'] as const) {
      expect(canRunAction('cancel_recording', makeSnapshot({ phase }))).toBe(false);
    }
  });

  it('allows copying only when idle with a transcript', () => {
    expect(canRunAction('copy_last_transcript', makeSnapshot())).toBe(false);
    expect(canRunAction('copy_last_transcript', makeSnapshot({ last_transcript: '' }))).toBe(false);
    expect(canRunAction('copy_last_transcript', makeSnapshot({ last_transcript: 'Текст' }))).toBe(true);
  });

  it.each([...sttPhases, ...ttsPhases])('rejects copying an existing transcript during %s', (phase) => {
    expect(canRunAction('copy_last_transcript', makeSnapshot({ phase, last_transcript: 'Текст' }))).toBe(false);
  });

  it('uses distinct Russian status labels for every phase', () => {
    expect(isBusy('idle')).toBe(false);
    expect(statusText('idle')).toBe('Готово к диктовке');
    expect(statusText('recording')).toBe('Идёт запись');
    expect(statusText('transcribing')).toBe('Обработка записи');
    expect(statusText('polishing')).toBe('Обработка текста');
    expect(statusText('synthesizing')).toBe('Создаём речь');
    expect(statusText('playing')).toBe('Воспроизводим речь');
  });
});

describe('settings validation', () => {
  it('accepts all suggested models, voices and platform default shortcuts', () => {
    for (const model of MODELS) {
      for (const shortcut of ['Super+R', 'Control+Super+R']) {
        expect(validateSettings({ ...settings, model: model.value, shortcut })).toBeNull();
      }
    }
    for (const model of TTS_MODELS) {
      expect(validateSettings({ ...settings, tts_model: model.value })).toBeNull();
    }
    for (const voice of TTS_VOICES) {
      expect(validateSettings({ ...settings, tts_voice: voice.value })).toBeNull();
    }
    expect(TTS_VOICES.some((voice) => voice.value === 'marin')).toBe(true);
  });

  it.each(['ctrl_v', 'ctrl_shift_v'] as const)('normalizes whitespace in every textual setting without replacing the device or paste chord %s', (paste_shortcut) => {
    expect(normalizeSettings({
      ...settings,
      shortcut: ' Control + Super + R ',
      model: ' whisper-1 ',
      tts_shortcut: ' Control + Super + A ',
      polish_shortcut: ' Control + Super + Backslash ',
      tts_model: ' gpt-4o-mini-tts ',
      tts_voice: ' marin ',
      input_device: 'mic-1',
      auto_paste: true,
      paste_shortcut,
    })).toEqual({
      ...settings,
      shortcut: 'Control+Super+R',
      model: 'whisper-1',
      tts_shortcut: 'Control+Super+A',
      polish_shortcut: 'Control+Super+Backslash',
      tts_model: 'gpt-4o-mini-tts',
      tts_voice: 'marin',
      input_device: 'mic-1',
      auto_paste: true,
      paste_shortcut,
    });
  });

  it.each(['', ' ', 'R', 'Super', 'Super+', 'Super++R', 'Super+Super+R', 'Unknown+R', 'Super+\nR'])
    ('rejects invalid shortcut %j', (shortcut) => {
      expect(validateSettings({ ...settings, shortcut })).not.toBeNull();
      expect(validateSettings({ ...settings, tts_shortcut: shortcut })).not.toBeNull();
    });

  it('rejects equivalent STT and TTS shortcuts regardless of modifier order or aliases', () => {
    expect(validateSettings({ ...settings, shortcut: 'Super+Control+A' })).toContain('не должны совпадать');
    expect(validateSettings({ ...settings, shortcut: 'Cmd+Ctrl+A' })).toContain('не должны совпадать');
  });

  it('accepts custom model and voice IDs without claiming API compatibility', () => {
    expect(validateSettings({
      ...settings,
      model: 'ft:custom_model.v2',
      tts_model: 'future-tts-snapshot',
      tts_voice: 'voice_1.0:preview',
    })).toBeNull();
  });

  it.each(['', ' ', 'gpt speech', 'gpt/speech', 'gpt\nspeech', '-invalid', 'модель', 'x'.repeat(129)])
    ('rejects malformed IDs %j', (value) => {
      expect(validateSettings({ ...settings, model: value })).not.toBeNull();
      expect(validateSettings({ ...settings, tts_model: value })).not.toBeNull();
      expect(validateSettings({ ...settings, tts_voice: value })).not.toBeNull();
    });

  it('rejects empty device IDs', () => {
    expect(validateSettings({ ...settings, input_device: '' })).not.toBeNull();
  });

  it('compares all settings fields', () => {
    expect(settingsEqual(settings, { ...settings })).toBe(true);
    for (const changed of [
      { shortcut: 'Alt+R' },
      { model: 'whisper-1' },
      { tts_shortcut: 'Alt+A' },
      { polish_shortcut: 'Alt+Backslash' },
      { tts_model: 'custom-tts' },
      { tts_voice: 'cedar' },
      { input_device: 'mic-1' },
      { auto_paste: true },
      { paste_shortcut: 'ctrl_shift_v' as const },
    ]) {
      expect(settingsEqual(settings, { ...settings, ...changed })).toBe(false);
    }
  });

  it('formats shortcut hints for macOS without changing stored settings', () => {
    expect(formatShortcutHint('Control+Super+A', true)).toBe('Ctrl+Cmd+A');
    expect(formatShortcutHint('Alt+Shift+Super+R', true)).toBe('Option+Shift+Cmd+R');
    expect(formatShortcutHint(settings.tts_shortcut, false)).toBe(settings.tts_shortcut);
    expect(settings.tts_shortcut).toBe('Control+Super+A');
  });
});

describe('polishing settings and retry guards', () => {
  const profile = { id: 'custom-example', name: 'Профиль', mode: 'llm' as const, instruction: 'Инструкция', prefix: '', suffix: '' };
  const withProfile: Settings = { ...settings, polish: { ...settings.polish, profile_id: profile.id, custom_profiles: [profile] } };

  it('normalizes model, profile name and instruction without mutating the input', () => {
    const input = { ...withProfile, polish: { ...withProfile.polish, model: ' gpt-5 ', custom_profiles: [{ ...profile, name: ' Имя ', instruction: ' Первая\n  вторая ' }] } };
    const normalized = normalizeSettings(input);
    expect(normalized.polish).toEqual({ profile_id: profile.id, model: 'gpt-5', effort: null, custom_profiles: [{ ...profile, name: 'Имя', instruction: 'Первая\n  вторая' }], favorite_profile_ids: [] });
    expect(input.polish.model).toBe(' gpt-5 ');
    expect(input.polish.custom_profiles[0]?.name).toBe(' Имя ');
  });

  it('preserves affix whitespace and validates local profiles without an LLM instruction', () => {
    const local = {
      ...profile,
      mode: 'local' as const,
      instruction: '',
      prefix: 'Диктовка:\n\n',
      suffix: '\n\nПроверь возможные ошибки распознавания.',
    };
    const input: Settings = {
      ...settings,
      polish: { ...settings.polish, profile_id: local.id, custom_profiles: [local] },
    };
    expect(normalizeSettings(input).polish.custom_profiles[0]).toMatchObject({
      instruction: '',
      prefix: 'Диктовка:\n\n',
      suffix: '\n\nПроверь возможные ошибки распознавания.',
    });
    expect(validateSettings(input)).toBeNull();
    expect(validateSettings({
      ...input,
      polish: { ...input.polish, custom_profiles: [{ ...local, prefix: ' \n', suffix: '' }] },
    })).toContain('префикс или суффикс');
  });

  it('compares every polishing field by value, including changes within profiles', () => {
    expect(settingsEqual(withProfile, structuredClone(withProfile))).toBe(true);
    for (const polish of [
      { ...withProfile.polish, model: 'gpt-5' },
      { ...withProfile.polish, profile_id: null },
      { ...withProfile.polish, effort: 'none' },
      { ...withProfile.polish, custom_profiles: [] },
      { ...withProfile.polish, favorite_profile_ids: [profile.id] },
      ...['id', 'name', 'instruction', 'mode', 'prefix', 'suffix'].map((field) => ({
        ...withProfile.polish,
        custom_profiles: [{ ...profile, [field]: field === 'mode' ? 'local' : 'different' }],
      })),
    ]) expect(settingsEqual(withProfile, { ...withProfile, polish })).toBe(false);
  });

  it('generates safe distinct IDs without using profile names', () => {
    const id = createPolishProfileId([profile]);
    const second = createPolishProfileId([profile, { ...profile, id }]);
    expect(id).toMatch(/^custom-[a-f0-9-]+$/);
    expect(second).not.toBe(id);
    expect(validateSettings({ ...settings, polish: { ...settings.polish, custom_profiles: [{ ...profile, id }] } })).toBeNull();
  });

  it('rejects invalid models, efforts, missing selections and invalid or conflicting custom profiles even when off', () => {
    for (const polish of [
      { ...settings.polish, model: '' },
      { ...settings.polish, model: 'gpt 5' },
      { ...settings.polish, model: 'gpt-5\n' },
      { ...settings.polish, effort: '' },
      { ...settings.polish, effort: 'extreme' },
      { ...settings.polish, profile_id: 'missing' },
      ...[
        [profile, profile],
        [{ ...profile, id: 'polish' }],
        [{ ...profile, id: 'markdown' }],
        [{ ...profile, id: 'developer' }],
        [{ ...profile, id: 'bad id' }],
        [{ ...profile, id: 'custom\n' }],
        [{ ...profile, name: 'я'.repeat(81) }],
        [{ ...profile, instruction: 'я'.repeat(8001) }],
        Array.from({ length: 33 }, (_, index) => ({ ...profile, id: `custom-${index}` })),
        [{ ...profile, name: ' ' }],
        [{ ...profile, instruction: '\n' }],
      ].map((custom_profiles) => ({ ...settings.polish, custom_profiles })),
    ]) expect(validateSettings({ ...settings, polish })).not.toBeNull();
    expect(validateSettings(withProfile)).toBeNull();
    expect(validateSettings({ ...withProfile, polish: { ...withProfile.polish, favorite_profile_ids: [profile.id] } })).toBeNull();
    expect(validateSettings({ ...withProfile, polish: { ...withProfile.polish, favorite_profile_ids: [profile.id, profile.id] } })).toContain('не должны повторяться');
    expect(validateSettings({ ...settings, polish: { ...settings.polish, favorite_profile_ids: ['missing'] } })).toContain('не найден');
    expect(validateSettings({ ...settings, polish: { ...settings.polish, custom_profiles: [
      { id: 'custom.v2:test', name: '😀'.repeat(80), mode: 'llm', instruction: '😀'.repeat(8000), prefix: '', suffix: '' },
    ] } })).toBeNull();
    for (const effort of [null, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(validateSettings({ ...settings, polish: { ...settings.polish, effort } })).toBeNull();
    }
  });

  it('allows retry only when idle, with a key and a failed job flagged by the backend', () => {
    const ready = makeSnapshot({ can_retry_polish: true });
    expect(canRunAction('retry_polish', ready)).toBe(true);
    expect(canRunAction('retry_polish', { ...ready, can_retry_polish: false })).toBe(false);
    expect(canRunAction('retry_polish', { ...ready, has_api_key: false })).toBe(false);
    for (const phase of [...sttPhases, ...ttsPhases]) {
      expect(canRunAction('retry_polish', { ...ready, phase })).toBe(false);
    }
  });
});

describe('key validation and errors', () => {
  it('validates key input without imposing a particular key prefix', () => {
    expect(validateApiKey('')).not.toBeNull();
    expect(validateApiKey('  ')).not.toBeNull();
    expect(validateApiKey('example key')).not.toBeNull();
    expect(validateApiKey('example\nkey')).not.toBeNull();
    expect(validateApiKey('x'.repeat(1025))).not.toBeNull();
    expect(validateApiKey('  example-key  ')).toBeNull();
  });

  it('extracts actionable strings from common invoke rejection shapes', () => {
    expect(errorMessage(new Error('Keyring unavailable'))).toBe('Keyring unavailable');
    expect(errorMessage('Нет разрешения')).toBe('Нет разрешения');
    expect(errorMessage({ message: 'Устройство отключено' })).toBe('Устройство отключено');
    expect(errorMessage(null)).toContain('Повторите действие');
    expect(errorMessage('')).toContain('Повторите действие');
  });
});
