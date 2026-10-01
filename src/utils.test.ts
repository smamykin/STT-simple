import { describe, expect, it } from 'vitest';
import { makeSnapshot } from './testFixtures';
import type { Action, Settings } from './types';
import {
  MODELS, canRunAction, errorMessage, formatDuration, isBusy, normalizeSettings,
  settingsEqual, statusText, validateApiKey, validateSettings,
} from './utils';

const settings: Settings = {
  shortcut: 'Super+R', model: 'gpt-4o-mini-transcribe', input_device: null, auto_paste: false,
};

const configurationActions: Action[] = [
  'save_settings', 'set_api_key', 'delete_api_key', 'reset_statistics', 'quit_app',
];

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

  it('does not enable actions without an initial snapshot', () => {
    for (const action of [...configurationActions, 'toggle_recording', 'cancel_recording', 'copy_last_transcript'] as Action[]) {
      expect(canRunAction(action, null)).toBe(false);
    }
  });

  it.each(['recording', 'transcribing', 'polishing'] as const)('locks settings, key and statistics during %s', (phase) => {
    expect(isBusy(phase)).toBe(true);
    for (const action of configurationActions) {
      expect(canRunAction(action, makeSnapshot({ phase }))).toBe(false);
    }
  });

  it('allows cancellation only during recording', () => {
    expect(canRunAction('cancel_recording', makeSnapshot({ phase: 'recording' }))).toBe(true);
    for (const phase of ['idle', 'transcribing', 'polishing'] as const) {
      expect(canRunAction('cancel_recording', makeSnapshot({ phase }))).toBe(false);
    }
  });

  it('allows copying only when idle with a transcript', () => {
    expect(canRunAction('copy_last_transcript', makeSnapshot())).toBe(false);
    expect(canRunAction('copy_last_transcript', makeSnapshot({ last_transcript: '' }))).toBe(false);
    expect(canRunAction('copy_last_transcript', makeSnapshot({ last_transcript: 'Текст' }))).toBe(true);
  });

  it.each(['recording', 'transcribing', 'polishing'] as const)('rejects copying an existing transcript during %s', (phase) => {
    expect(canRunAction('copy_last_transcript', makeSnapshot({ phase, last_transcript: 'Текст' }))).toBe(false);
  });

  it('uses Russian status labels and treats the reserved phase as processing', () => {
    expect(isBusy('idle')).toBe(false);
    expect(statusText('idle')).toBe('Готово к диктовке');
    expect(statusText('recording')).toBe('Идёт запись');
    expect(statusText('transcribing')).toBe('Обработка записи');
    expect(statusText('polishing')).toBe(statusText('transcribing'));
  });
});

describe('settings validation', () => {
  it('accepts all supported models and the platform default shortcuts', () => {
    for (const model of MODELS) {
      for (const shortcut of ['Super+R', 'Control+Super+R']) {
        expect(validateSettings({ ...settings, model: model.value, shortcut })).toBeNull();
      }
    }
  });

  it('normalizes whitespace without replacing the selected device', () => {
    expect(normalizeSettings({ shortcut: ' Control + Super + R ', model: ' whisper-1 ', input_device: 'mic-1', auto_paste: true }))
      .toEqual({ shortcut: 'Control+Super+R', model: 'whisper-1', input_device: 'mic-1', auto_paste: true });
  });

  it.each(['', ' ', 'R', 'Super', 'Super+', 'Super++R', 'Super+Super+R', 'Unknown+R', 'Super+\nR'])
    ('rejects invalid shortcut %j', (shortcut) => {
      expect(validateSettings({ ...settings, shortcut })).not.toBeNull();
    });

  it('accepts custom model IDs and snapshots without claiming API compatibility', () => {
    for (const model of ['gpt-transcribe', 'gpt-transcribe-future-snapshot', 'gpt-4o-mini-transcribe-2025-12-15', 'ft:custom_model.v2']) {
      expect(validateSettings({ ...settings, model })).toBeNull();
    }
  });

  it.each(['', ' ', 'gpt transcribe', 'gpt/transcribe', 'gpt\ntranscribe', 'gpt-transcribe\n', 'gpt-transcribe\r', '-invalid', 'модель', 'x'.repeat(129)])
    ('rejects malformed model ID %j', (model) => {
      expect(validateSettings({ ...settings, model })).not.toBeNull();
    });

  it('rejects empty device IDs', () => {
    expect(validateSettings({ ...settings, input_device: '' })).not.toBeNull();
  });

  it('compares all settings fields', () => {
    expect(settingsEqual(settings, { ...settings })).toBe(true);
    expect(settingsEqual(settings, { ...settings, shortcut: 'Alt+R' })).toBe(false);
    expect(settingsEqual(settings, { ...settings, model: 'whisper-1' })).toBe(false);
    expect(settingsEqual(settings, { ...settings, input_device: 'mic-1' })).toBe(false);
    expect(settingsEqual(settings, { ...settings, auto_paste: true })).toBe(false);
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
