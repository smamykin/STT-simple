// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useAppState } from './useAppState';
import { TranscriptResult } from './TranscriptResult';
import { deferred, makeSnapshot } from './testFixtures';
import type { Action, Settings, Snapshot } from './types';
import { MODELS } from './utils';

const backend = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  listInputDevices: vi.fn(),
  listOpenAiModels: vi.fn(),
  saveSettings: vi.fn(),
  setApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  toggleRecording: vi.fn(),
  toggleSpeech: vi.fn(),
  cancelRecording: vi.fn(),
  resetStatistics: vi.fn(),
  copyLastTranscript: vi.fn(),
  copyLastRawTranscript: vi.fn(),
  retryPolish: vi.fn(),
  cyclePolishProfile: vi.fn(),
  quitApp: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('./backend', () => ({ inTauri: true, backend }));

const listeners = new Set<(snapshot: Snapshot) => void>();

function emit(snapshot: Snapshot) {
  act(() => {
    for (const listener of listeners) listener(snapshot);
  });
}

async function mount(snapshot = makeSnapshot()) {
  backend.getSnapshot.mockResolvedValue(snapshot);
  const app = render(<StrictMode><App /></StrictMode>);
  await waitFor(() => expect(backend.listInputDevices).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByLabelText('Есть несохранённые изменения')).toBeNull());
  return app;
}

function openSettings() {
  fireEvent.click(screen.getByRole('button', { name: /^Настройки/ }));
  expect(screen.getByRole('heading', { name: 'Настройки приложения' })).toBeTruthy();
}

function openHome() {
  fireEvent.click(screen.getByRole('button', { name: /^К диктовке/ }));
  expect(screen.getByRole('region', { name: 'Последний результат' })).toBeTruthy();
}

async function mountSettings(snapshot = makeSnapshot()) {
  const app = await mount(snapshot);
  openSettings();
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Сочетание клавиш' })).toHaveProperty('value', snapshot.settings.shortcut));
  return app;
}

beforeEach(() => {
  vi.resetAllMocks();
  listeners.clear();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  backend.getSnapshot.mockResolvedValue(makeSnapshot());
  backend.listInputDevices.mockResolvedValue([
    { id: 'mic-1', name: 'USB микрофон', is_default: true },
    { id: 'mic-2', name: 'Гарнитура', is_default: false },
  ]);
  backend.subscribe.mockImplementation(async (callback: (snapshot: Snapshot) => void) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('polishing interface', () => {
  const refreshModels = () => screen.getByRole('button', { name: 'Обновить модели OpenAI' });

  it('refreshes explicitly, deduplicates without capability filtering and preserves dirty settings on errors and empty results', async () => {
    await mountSettings();
    expect(backend.listOpenAiModels).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: 'Super+T' } });
    const response = deferred<{ id: string; created: number }[]>();
    backend.listOpenAiModels.mockReturnValueOnce(response.promise);
    act(() => { fireEvent.click(refreshModels()); fireEvent.click(refreshModels()); });
    expect(backend.listOpenAiModels).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Загрузка моделей OpenAI…')).toBeTruthy();
    await act(async () => response.resolve(['gpt-6-luna', 'whisper-1', 'embedding-model', 'whisper-1'].map((id) => ({ id, created: 1 }))));
    const select = screen.getByLabelText('Модель обработки текста') as HTMLSelectElement;
    expect(select.value).toBe('gpt-6-luna');
    expect(Array.from(select.options).filter((option) => option.value === 'gpt-6-luna')).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Каталог OpenAI — совместимость не проверена' }).textContent).toBe('whisper-1embedding-model');
    fireEvent.change(select, { target: { value: 'embedding-model' } });
    fireEvent.change(screen.getByLabelText('Уровень рассуждения'), { target: { value: 'max' } });
    backend.listOpenAiModels.mockRejectedValueOnce(new Error('Catalog unavailable'));
    fireEvent.click(refreshModels());
    await screen.findByText(/Catalog unavailable/);
    expect(select.value).toBe('embedding-model');
    expect(screen.getByLabelText('Уровень рассуждения')).toHaveProperty('value', 'max');
    expect(screen.getByLabelText('Сочетание клавиш')).toHaveProperty('value', 'Super+T');
    backend.listOpenAiModels.mockResolvedValueOnce([]);
    fireEvent.click(refreshModels());
    await screen.findByText(/Нет дополнительных моделей/);
    expect(screen.getByLabelText('ID модели обработки OpenAI')).toHaveProperty('value', 'embedding-model');
    expect(backend.saveSettings).not.toHaveBeenCalled();
  });

  it('invalidates pending catalogs when replacing a stored key and on unmount', async () => {
    const app = await mountSettings();
    const stale = deferred<{ id: string; created: number }[]>();
    backend.listOpenAiModels.mockReturnValueOnce(stale.promise);
    fireEvent.click(refreshModels());
    backend.setApiKey.mockResolvedValue(makeSnapshot());
    fireEvent.change(screen.getByLabelText('Новый ключ'), { target: { value: 'test-only-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить ключ' }));
    await waitFor(() => expect(screen.getByLabelText('Новый ключ')).toHaveProperty('value', ''));
    await act(async () => stale.resolve([{ id: 'stale-model', created: 1 }]));
    expect(screen.queryByRole('option', { name: 'stale-model' })).toBeNull();
    const pending = deferred<{ id: string; created: number }[]>();
    backend.listOpenAiModels.mockReturnValueOnce(pending.promise);
    await waitFor(() => expect(refreshModels().matches(':disabled')).toBe(false));
    fireEvent.click(refreshModels());
    app.unmount();
    await act(async () => pending.reject(new Error('late error')));
  });

  it('disables catalog refresh when the backend is disconnected', async () => {
    backend.getSnapshot.mockRejectedValue(new Error('offline'));
    render(<App />);
    await screen.findByText('Нет связи с приложением');
    openSettings();
    expect(refreshModels().matches(':disabled')).toBe(true);
    fireEvent.click(refreshModels());
    expect(backend.listOpenAiModels).not.toHaveBeenCalled();
  });

  it('allows manual IDs without a key and inherits busy disabling', async () => {
    const snapshot = makeSnapshot({ has_api_key: false });
    await mountSettings(snapshot);
    expect(refreshModels().matches(':disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Модель обработки текста'), { target: { value: '__custom__' } });
    fireEvent.change(screen.getByLabelText('ID модели обработки OpenAI'), { target: { value: 'my-model' } });
    expect(screen.getByLabelText('ID модели обработки OpenAI')).toHaveProperty('value', 'my-model');
    emit(makeSnapshot({ phase: 'polishing' }));
    expect(refreshModels().matches(':disabled')).toBe(true);
    expect(backend.listOpenAiModels).not.toHaveBeenCalled();
  });

  it.each(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'])('shows documented efforts for %s and retains incompatible saved values', async (model) => {
    const snapshot = makeSnapshot();
    snapshot.settings.polish = { ...snapshot.settings.polish, model, effort: 'minimal' };
    await mountSettings(snapshot);
    const effort = screen.getByLabelText('Уровень рассуждения') as HTMLSelectElement;
    expect(effort.value).toBe('minimal');
    expect(screen.getByText(/не поддерживается выбранной моделью/)).toBeTruthy();
    expect(Array.from(effort.options).map((option) => option.value)).toEqual([
      '', 'minimal', ...(model === 'gpt-6-luna' ? ['none'] : []), 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
    expect(backend.saveSettings).not.toHaveBeenCalled();
  });

  it('preserves legacy saved models and exposes all efforts for unknown capabilities', async () => {
    const snapshot = makeSnapshot();
    snapshot.settings.polish = { ...snapshot.settings.polish, model: 'gpt-5-mini', effort: 'minimal' };
    await mountSettings(snapshot);
    expect(screen.getByLabelText('ID модели обработки OpenAI')).toHaveProperty('value', 'gpt-5-mini');
    expect(screen.getByLabelText('Уровень рассуждения')).toHaveProperty('value', 'minimal');
    expect(screen.getByText(/\/models не содержит метаданных/)).toBeTruthy();
    expect(Array.from((screen.getByLabelText('Уровень рассуждения') as HTMLSelectElement).options).map((option) => option.value))
      .toEqual(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
  it('loads builtin profiles from the snapshot and keeps their instructions immutable', async () => {
    const snapshot = makeSnapshot();
    snapshot.builtin_polish_profiles[0] = { id: 'polish', name: 'Правка из core', mode: 'llm', instruction: 'Инструкция из core', prefix: '', suffix: '' };
    await mountSettings(snapshot);
    expect(screen.getByLabelText('Профиль обработки текста')).toHaveProperty('value', '');
    expect(screen.getByLabelText('Модель обработки текста')).toHaveProperty('value', 'gpt-6-luna');
    expect(screen.getByLabelText('Уровень рассуждения')).toHaveProperty('value', '');
    expect(screen.getByText(/дополнительный платный запрос/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Профиль обработки текста'), { target: { value: 'polish' } });
    expect(screen.getByLabelText('Инструкция профиля')).toHaveProperty('value', 'Инструкция из core');
    expect(screen.getByLabelText('Инструкция профиля')).toHaveProperty('readOnly', true);
    expect(screen.queryByLabelText('Название профиля')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Удалить профиль' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Дублировать профиль' }));
    expect(screen.getByLabelText('Название профиля')).toHaveProperty('value', 'Правка из core — копия');
    expect(screen.getByLabelText('Инструкция профиля')).toHaveProperty('readOnly', false);
    expect((screen.getByLabelText('Профиль обработки текста') as HTMLSelectElement).value).not.toBe('polish');
    expect(backend.saveSettings).not.toHaveBeenCalled();
  });

  it('edits favorite profiles independently and explains cycle semantics', async () => {
    const snapshot = makeSnapshot();
    snapshot.settings.polish = {
      ...snapshot.settings.polish,
      custom_profiles: [{ id: 'custom-test', name: 'Мой профиль', mode: 'llm', instruction: 'Инструкция', prefix: '', suffix: '' }],
      favorite_profile_ids: ['markdown'],
    };
    await mountSettings(snapshot);
    const polish = screen.getByLabelText('Избранный профиль: Минимальная правка');
    const markdown = screen.getByLabelText('Избранный профиль: Markdown');
    const developer = screen.getByLabelText('Избранный профиль: Сообщение разработчика');
    const custom = screen.getByLabelText('Избранный профиль: Мой профиль');
    expect(polish).toHaveProperty('checked', false);
    expect(markdown).toHaveProperty('checked', true);
    expect(developer).toHaveProperty('checked', false);
    expect(custom).toHaveProperty('checked', false);
    expect(screen.getByText(/«Выключено» всегда участвует в цикле/)).toBeTruthy();
    expect(screen.getByText(/Один избранный профиль превращает переключение в тумблер/)).toBeTruthy();
    fireEvent.click(polish);
    fireEvent.click(custom);
    fireEvent.click(markdown);
    expect(polish).toHaveProperty('checked', true);
    expect(markdown).toHaveProperty('checked', false);
    expect(custom).toHaveProperty('checked', true);
    expect(backend.saveSettings).not.toHaveBeenCalled();
  });

  it('shows the Linux cycle shortcut and its GNOME registration status', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
      const snapshot = makeSnapshot({ hotkey_mode: 'system', polish_hotkey_available: true });
      snapshot.settings.polish_shortcut = 'Super+Backslash';
      await mountSettings(snapshot);
      expect(screen.getByLabelText('Сочетание клавиш переключения обработки')).toHaveProperty('value', 'Super+Backslash');
      expect(screen.getByLabelText('Сочетание клавиш переключения обработки')).toHaveProperty('placeholder', 'Super+Backslash');
      const shortcut = screen.getAllByText('Win+\\', { selector: 'kbd' });
      expect(shortcut).toHaveLength(2);
      expect(shortcut[1]?.parentElement?.textContent).toContain('настроено в GNOME');
      expect(shortcut[1]?.parentElement?.textContent).not.toContain('вручную');
      emit({ ...snapshot, polish_hotkey_available: false });
      expect(screen.getAllByText('Win+\\', { selector: 'kbd' })[1]?.parentElement?.textContent).toContain('не настроено в GNOME');
    });

    it('shows the macOS cycle shortcut and locks it with favorite controls while busy', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15',
    );
    await mountSettings();
    expect(screen.getByLabelText('Сочетание клавиш переключения обработки')).toHaveProperty('value', 'Control+Super+Backslash');
    expect(screen.getByText('Ctrl+Cmd+\\', { selector: 'kbd' })).toBeTruthy();
    emit(makeSnapshot({ phase: 'recording' }));
    expect(screen.getByLabelText('Сочетание клавиш переключения обработки').matches(':disabled')).toBe(true);
    for (const favorite of screen.getAllByRole('checkbox', { name: /Избранный профиль:/ })) {
      expect(favorite.matches(':disabled')).toBe(true);
    }
  });

  it('edits and saves a local profile with exact prefix and suffix without an LLM instruction', async () => {
    const snapshot = makeSnapshot();
    await mountSettings(snapshot);
    backend.saveSettings.mockImplementation(async (settings: Settings) => ({ ...snapshot, settings }));
    fireEvent.click(screen.getByRole('button', { name: 'Создать профиль' }));
    expect(screen.getByLabelText('Способ обработки')).toHaveProperty('value', 'llm');
    fireEvent.change(screen.getByLabelText('Способ обработки'), { target: { value: 'local' } });
    expect(screen.queryByLabelText('Инструкция профиля')).toBeNull();
    fireEvent.change(screen.getByLabelText('Префикс'), { target: { value: 'Диктовка:\n\n' } });
    fireEvent.change(screen.getByLabelText('Суффикс'), { target: { value: '\n\nПроверь распознавание.' } });
    expect(screen.getByLabelText('Префикс')).toHaveProperty('value', 'Диктовка:\n\n');
    expect(screen.getByLabelText('Суффикс')).toHaveProperty('value', '\n\nПроверь распознавание.');
    expect(screen.getByText(/не отправляет текст на дополнительную обработку OpenAI/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledTimes(1));
    expect(backend.saveSettings.mock.calls[0]?.[0].polish.custom_profiles).toEqual([expect.objectContaining({
      name: 'Новый профиль', mode: 'local', instruction: '', prefix: 'Диктовка:\n\n',
      suffix: '\n\nПроверь распознавание.',
    })]);
  });

  it('creates, edits and deletes custom profiles only through the existing settings save', async () => {
    let snapshot = makeSnapshot();
    await mountSettings(snapshot);
    backend.saveSettings.mockImplementation(async (settings: Settings) => {
      snapshot = { ...snapshot, settings };
      backend.getSnapshot.mockResolvedValue(snapshot);
      return snapshot;
    });
    const save = async () => {
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Сохранить настройки' })).toHaveProperty('disabled', true));
      await waitFor(() => expect(screen.getByLabelText('Профиль обработки текста').matches(':disabled')).toBe(false));
    };
    fireEvent.click(screen.getByRole('button', { name: 'Создать профиль' }));
    const id = (screen.getByLabelText('Профиль обработки текста') as HTMLSelectElement).value;
    expect(id).toMatch(/^custom-[a-f0-9-]+$/);
    fireEvent.change(screen.getByLabelText('Название профиля'), { target: { value: ' Мой профиль ' } });
    fireEvent.change(screen.getByLabelText('Инструкция профиля'), { target: { value: ' Сохрани\nвсе детали. ' } });
    expect(backend.saveSettings).not.toHaveBeenCalled();
    await save();
    expect(snapshot.settings.polish.custom_profiles).toEqual([{
      id, name: 'Мой профиль', mode: 'llm', instruction: 'Сохрани\nвсе детали.', prefix: '', suffix: '',
    }]);
    expect(snapshot.settings.polish.profile_id).toBe(id);
    fireEvent.change(screen.getByLabelText('Название профиля'), { target: { value: 'Правка' } });
    fireEvent.change(screen.getByLabelText('Инструкция профиля'), { target: { value: 'Новая инструкция' } });
    // Even a settings-changing state event must not discard a dirty form.
    emit({ ...snapshot, settings: { ...snapshot.settings, model: 'whisper-1' } });
    expect(screen.getByLabelText('Название профиля')).toHaveProperty('value', 'Правка');
    expect(screen.getByLabelText('Инструкция профиля')).toHaveProperty('value', 'Новая инструкция');
    await save();
    expect(snapshot.settings.polish.custom_profiles).toEqual([{
      id, name: 'Правка', mode: 'llm', instruction: 'Новая инструкция', prefix: '', suffix: '',
    }]);
    fireEvent.click(screen.getByRole('button', { name: 'Удалить профиль' }));
    expect(screen.getByLabelText('Профиль обработки текста')).toHaveProperty('value', '');
    expect(snapshot.settings.polish.custom_profiles).toHaveLength(1);
    await save();
    expect(snapshot.settings.polish).toEqual({ profile_id: null, model: 'gpt-6-luna', effort: null, custom_profiles: [], favorite_profile_ids: [] });
    expect(backend.saveSettings).toHaveBeenCalledTimes(3);
  });

  it('rebases an untouched profile selection after an external cycle without discarding other dirty fields', async () => {
    const initial = makeSnapshot();
    await mountSettings(initial);
    fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: 'Super+T' } });
    const cycled = makeSnapshot();
    cycled.settings.polish.profile_id = 'markdown';
    emit(cycled);
    expect(screen.getByLabelText('Профиль обработки текста')).toHaveProperty('value', 'markdown');
    expect(screen.getByLabelText('Сочетание клавиш')).toHaveProperty('value', 'Super+T');
    backend.saveSettings.mockImplementation(async (settings: Settings) => ({ ...cycled, settings }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledTimes(1));
    expect(backend.saveSettings.mock.calls[0]?.[0].polish.profile_id).toBe('markdown');
    expect(backend.saveSettings.mock.calls[0]?.[0].shortcut).toBe('Super+T');
  });

  it('preserves an explicitly edited profile selection when an external cycle arrives', async () => {
    const initial = makeSnapshot();
    await mountSettings(initial);
    fireEvent.change(screen.getByLabelText('Профиль обработки текста'), { target: { value: 'developer' } });
    fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: 'Super+T' } });
    const cycled = makeSnapshot();
    cycled.settings.polish.profile_id = 'markdown';
    emit(cycled);
    expect(screen.getByLabelText('Профиль обработки текста')).toHaveProperty('value', 'developer');
    expect(screen.getByLabelText('Сочетание клавиш')).toHaveProperty('value', 'Super+T');
    backend.saveSettings.mockImplementation(async (settings: Settings) => ({ ...cycled, settings }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledTimes(1));
    expect(backend.saveSettings.mock.calls[0]?.[0].polish.profile_id).toBe('developer');
  });

  it('removes a deleted custom profile from favorites', async () => {
    const snapshot = makeSnapshot();
    snapshot.settings.polish = {
      ...snapshot.settings.polish,
      profile_id: 'custom-test',
      custom_profiles: [{ id: 'custom-test', name: 'Мой профиль', mode: 'llm', instruction: 'Инструкция', prefix: '', suffix: '' }],
      favorite_profile_ids: ['polish', 'custom-test'],
    };
    await mountSettings(snapshot);
    backend.saveSettings.mockImplementation(async (settings: Settings) => ({ ...snapshot, settings }));
    fireEvent.click(screen.getByRole('button', { name: 'Удалить профиль' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalled());
    expect(backend.saveSettings.mock.calls[0]?.[0].polish.favorite_profile_ids).toEqual(['polish']);
  });

  it.each(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])('saves a custom model and effort %j without resetting the draft on state events', async (effort) => {
    const initial = makeSnapshot();
    await mountSettings(initial);
    fireEvent.change(screen.getByLabelText('Профиль обработки текста'), { target: { value: 'developer' } });
    fireEvent.change(screen.getByLabelText('Модель обработки текста'), { target: { value: '__custom__' } });
    fireEvent.change(screen.getByLabelText('ID модели обработки OpenAI'), { target: { value: ' custom-model.v2 ' } });
    fireEvent.change(screen.getByLabelText('Уровень рассуждения'), { target: { value: effort } });
    emit(structuredClone(initial));
    expect(screen.getByLabelText('ID модели обработки OpenAI')).toHaveProperty('value', ' custom-model.v2 ');
    const settings = { ...initial.settings, polish: { ...initial.settings.polish, profile_id: 'developer', model: 'custom-model.v2', effort: effort || null } };
    const saved = { ...initial, settings };
    backend.saveSettings.mockResolvedValue(saved);
    backend.getSnapshot.mockResolvedValue(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledExactlyOnceWith(settings));
    await screen.findByText('Настройки сохранены.');
  });

  it('validates custom profiles even when processing is switched off and retains drafts after a failed save', async () => {
    await mountSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Создать профиль' }));
    fireEvent.change(screen.getByLabelText('Профиль обработки текста'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(await screen.findByText(/через OpenAI укажите инструкцию/)).toBeTruthy();
    expect(backend.saveSettings).not.toHaveBeenCalled();
    const option = screen.getByRole('option', { name: 'Новый профиль' }) as HTMLOptionElement;
    fireEvent.change(screen.getByLabelText('Профиль обработки текста'), { target: { value: option.value } });
    fireEvent.change(screen.getByLabelText('Инструкция профиля'), { target: { value: 'Моя инструкция' } });
    backend.saveSettings.mockRejectedValue(new Error('Не удалось сохранить'));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await screen.findByText('Действие не выполнено');
    emit(structuredClone(makeSnapshot()));
    expect(screen.getByLabelText('Инструкция профиля')).toHaveProperty('value', 'Моя инструкция');
  });

  it('retries only the failed backend job without submitting draft settings or copying the raw text', async () => {
    const initial = makeSnapshot({
      last_raw_transcript: 'сырой текст', last_transcript: null,
      previous_transcript: 'Предыдущий успех', can_retry_polish: true,
    });
    await mount(initial);
    expect(screen.getByLabelText('Исходный текст распознавания')).toHaveProperty('value', 'сырой текст');
    expect(screen.queryByRole('textbox', { name: 'Текст последней диктовки' })).toBeNull();
    fireEvent.click(screen.getByText('Предыдущий успешный результат', { selector: 'summary' }));
    expect(screen.getByRole('textbox', { name: 'Предыдущий успешный текст' })).toHaveProperty('value', 'Предыдущий успех');
    openSettings();
    fireEvent.change(screen.getByRole('combobox', { name: 'Профиль обработки текста' }), { target: { value: 'markdown' } });
    expect(screen.queryByRole('button', { name: 'Повторить обработку текста' })).toBeNull();
    openHome();
    expect(screen.getByText(/Повтор использует настройки неудавшейся задачи/)).toBeTruthy();
    const retry = deferred<void>();
    backend.retryPolish.mockReturnValue(retry.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить обработку текста' }));
    expect(backend.retryPolish).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole('button', { name: 'Повтор…' })).toHaveProperty('disabled', true);
    openSettings();
    expect(screen.getByRole('combobox', { name: 'Профиль обработки текста' }).matches(':disabled')).toBe(true);
    openHome();
    expect(backend.saveSettings).not.toHaveBeenCalled();
    expect(backend.copyLastTranscript).not.toHaveBeenCalled();
    expect(backend.copyLastRawTranscript).not.toHaveBeenCalled();
    const success = {
      ...initial, can_retry_polish: false, has_pending_polish: false,
      previous_transcript: null, last_transcript: 'Готовый результат',
    };
    backend.getSnapshot.mockResolvedValue(success);
    await act(async () => retry.resolve());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Повторить обработку текста' })).toBeNull());
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', 'Готовый результат');
    expect(screen.queryByText('Обработка текста не завершена')).toBeNull();
    expect(screen.queryByText('Предыдущий успешный результат')).toBeNull();
    expect(screen.getByRole('button', { name: 'Показать исходный текст' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('textbox', { name: 'Исходный текст распознавания' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Скопировать' })).toHaveProperty('disabled', false);
    openSettings();
    expect(screen.getByRole('combobox', { name: 'Профиль обработки текста' })).toHaveProperty('value', 'markdown');
    expect(backend.saveSettings).not.toHaveBeenCalled();
  });

  it.each(['recording', 'transcribing', 'polishing', 'synthesizing', 'playing', 'no-key', 'unavailable'] as const)('does not allow retry in %s', async (state) => {
    await mount(makeSnapshot({
      phase: state === 'no-key' || state === 'unavailable' ? 'idle' : state,
      has_pending_polish: state !== 'unavailable', can_retry_polish: state === 'no-key',
      has_api_key: state !== 'no-key', last_transcript: null, last_raw_transcript: 'Текст',
    }));
    const button = screen.queryByRole('button', { name: 'Повторить обработку текста' });
    if (state === 'unavailable') expect(button).toBeNull();
    else {
      expect(button).toHaveProperty('disabled', true);
      fireEvent.click(button!);
    }
    expect(backend.retryPolish).not.toHaveBeenCalled();
    if (state === 'unavailable' || state === 'polishing') expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', '');
    else expect(screen.queryByRole('textbox', { name: 'Текст последней диктовки' })).toBeNull();
  });

  it.each(['recording', 'transcribing', 'polishing', 'synthesizing', 'playing'] as const)('locks custom profile editing during %s', async (phase) => {
    const snapshot = makeSnapshot({ phase });
    snapshot.settings.polish = { ...snapshot.settings.polish, profile_id: 'custom-test',
      custom_profiles: [{ id: 'custom-test', name: 'Профиль', mode: 'llm', instruction: 'Инструкция', prefix: '', suffix: '' }] };
    await mountSettings(snapshot);
    for (const label of ['Название профиля', 'Инструкция профиля']) {
      expect(screen.getByLabelText(label).matches(':disabled')).toBe(true);
    }
    for (const name of ['Создать профиль', 'Дублировать профиль', 'Удалить профиль']) {
      expect(screen.getByRole('button', { name }).matches(':disabled')).toBe(true);
    }
  });

  it('reports retry errors without replacing the last successful text', async () => {
    await mount(makeSnapshot({
      can_retry_polish: true, last_transcript: null,
      previous_transcript: 'Успех', last_raw_transcript: 'Исходный',
    }));
    backend.retryPolish.mockRejectedValue(new Error('OpenAI недоступен'));
    fireEvent.click(screen.getByRole('button', { name: 'Повторить обработку текста' }));
    await screen.findByText(/Не удалось повторить обработку текста: OpenAI недоступен/);
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Исходный');
    expect(screen.queryByRole('textbox', { name: 'Текст последней диктовки' })).toBeNull();
    fireEvent.click(screen.getByText('Предыдущий успешный результат', { selector: 'summary' }));
    expect(screen.getByRole('textbox', { name: 'Предыдущий успешный текст' })).toHaveProperty('value', 'Успех');
  });
});

describe('Russian dictation interface', () => {
  it('shows the backend snapshot, accessible labels, statistics and device choices', async () => {
    await mount(makeSnapshot({
      last_transcript: 'Проверка диктовки',
      recording_seconds: 7,
      statistics: { last_recording_seconds: 65, total_recording_seconds: 3661, recordings: 2 },
    }));
    expect(screen.getByRole('heading', { name: 'STT Simple' })).toBeTruthy();
    expect(screen.getByLabelText('Текст последней диктовки')).toHaveProperty('value', 'Проверка диктовки');
    expect(screen.getByRole('timer').textContent).toBe('00:07');
    expect(screen.getByText('01:05')).toBeTruthy();
    expect(screen.getByText('01:01:01')).toBeTruthy();
    openSettings();
    expect(screen.getByRole('option', { name: 'USB микрофон — по умолчанию' })).toBeTruthy();
    expect(screen.getAllByRole('option').filter((option) => option.parentElement?.id === 'model')).toHaveLength(MODELS.length + 1);
    expect(screen.getByRole('option', { name: 'GPT Transcribe — рекомендован OpenAI' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'GPT-4o mini Transcribe — 2025-12-15' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'GPT-4o mini TTS — рекомендован OpenAI' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Marin — рекомендован OpenAI' })).toBeTruthy();
  });

  it('requires an API key before enabling start', async () => {
    await mount(makeSnapshot({ has_api_key: false }));
    expect(screen.getByRole('button', { name: 'Начать запись' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Озвучить буфер' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Сохраните API-ключ OpenAI, чтобы начать.')).toBeTruthy();
  });

  it('starts, stops and cancels only through the backend commands', async () => {
    await mount();
    backend.toggleRecording.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Начать запись' }));
    await waitFor(() => expect(backend.toggleRecording).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Начать запись' })).toHaveProperty('disabled', false));

    emit(makeSnapshot({ phase: 'recording', has_api_key: false }));
    // A separate click more than 400 ms later is a stop, not the second half of a double click.
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
    fireEvent.click(screen.getByRole('button', { name: 'Остановить' }));
    await waitFor(() => expect(backend.toggleRecording).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Начать запись' })).toHaveProperty('disabled', false));
    backend.cancelRecording.mockResolvedValue(undefined);
    emit(makeSnapshot({ phase: 'recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Отменить запись' }));
    await waitFor(() => expect(backend.cancelRecording).toHaveBeenCalledOnce());
  });

  it('starts and stops speech through the backend without exposing clipboard contents', async () => {
    await mount();
    backend.toggleSpeech.mockResolvedValue(undefined);
    expect(screen.getByText(/Текст из буфера обмена отправляется в OpenAI/)).toBeTruthy();
    expect(screen.getByText(/Голос сгенерирован ИИ/)).toBeTruthy();
    expect(screen.getByText(/Использование API оплачивается вашим аккаунтом OpenAI; приложение не рассчитывает стоимость/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Озвучить буфер' }));
    await waitFor(() => expect(backend.toggleSpeech).toHaveBeenCalledOnce());

    emit(makeSnapshot({ phase: 'synthesizing', has_api_key: false }));
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
    expect(screen.getByText('Создаём речь', { selector: '.speech-card .status-badge' })).toBeTruthy();
    const stop = screen.getByRole('button', { name: 'Остановить' });
    expect(stop).toHaveProperty('disabled', false);
    fireEvent.click(stop);
    await waitFor(() => expect(backend.toggleSpeech).toHaveBeenCalledTimes(2));
    expect(document.body.textContent).not.toContain('runtime session');
    expect(document.body.textContent).not.toContain('WAV');
  });

  it.each(['synthesizing', 'playing'] as const)('keeps recording available during %s when a key exists', async (phase) => {
    await mount(makeSnapshot({ phase, has_api_key: true }));
    const record = screen.getByRole('button', { name: 'Начать запись' });
    expect(record).toHaveProperty('disabled', false);
    backend.toggleRecording.mockResolvedValue(undefined);
    fireEvent.click(record);
    await waitFor(() => expect(backend.toggleRecording).toHaveBeenCalledOnce());
  });

  it.each(['recording', 'transcribing', 'polishing'] as const)('disables speech during %s', async (phase) => {
    await mount(makeSnapshot({ phase }));
    expect(screen.getByRole('button', { name: 'Озвучить буфер' })).toHaveProperty('disabled', true);
  });

  it.each(['recording', 'transcribing', 'polishing', 'synthesizing', 'playing'] as const)('locks settings, key and statistics during %s', async (phase) => {
    await mount(makeSnapshot({
      phase,
      statistics: { last_recording_seconds: 5, total_recording_seconds: 5, recordings: 1 },
    }));
    openSettings();
    for (const label of ['Микрофон', 'Модель', 'Сочетание клавиш', 'TTS-модель', 'Голос', 'Сочетание клавиш озвучивания', 'Новый ключ', 'Профиль обработки текста', 'Модель обработки текста', 'Уровень рассуждения']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).matches(':disabled')).toBe(true);
    }
    expect(screen.getByRole('button', { name: 'Сбросить' })).toHaveProperty('disabled', true);
    openHome();
    expect(Boolean(screen.queryByRole('button', { name: 'Отменить запись' }))).toBe(phase === 'recording');
    if (phase === 'transcribing' || phase === 'polishing') {
      expect(screen.getByRole('button', { name: 'Обработка…' })).toHaveProperty('disabled', true);
    }
  });

  it.each(['recording', 'transcribing', 'polishing', 'synthesizing', 'playing'] as const)('disables Copy during %s even with a transcript and re-enables it when idle', async (phase) => {
    const idle = makeSnapshot({ last_transcript: 'Готовый текст' });
    await mount(idle);
    const copy = screen.getByRole('button', { name: 'Скопировать' });
    expect(copy).toHaveProperty('disabled', false);
    emit({ ...idle, phase });
    expect(copy).toHaveProperty('disabled', true);
    fireEvent.click(copy);
    expect(backend.copyLastTranscript).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Текст последней диктовки')).toHaveProperty('value', 'Готовый текст');
    emit(idle);
    expect(copy).toHaveProperty('disabled', false);
  });

  it.each([null, ''])('disables Copy when idle without a transcript (%j)', async (last_transcript) => {
    await mount(makeSnapshot({ last_transcript }));
    expect(screen.getByRole('button', { name: 'Скопировать' })).toHaveProperty('disabled', true);
  });

  it('saves normalized settings and maps the default microphone to null', async () => {
    const original = makeSnapshot({ settings: { ...makeSnapshot().settings, input_device: 'mic-1' } });
    await mountSettings(original);
    const settings: Settings = {
      ...original.settings,
      shortcut: 'Control+Super+R', model: 'whisper-1', input_device: null, auto_paste: false,
    };
    const saved = makeSnapshot({ settings });
    backend.saveSettings.mockResolvedValue(saved);
    backend.getSnapshot.mockResolvedValue(saved);
    fireEvent.change(screen.getByLabelText('Микрофон'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Модель'), { target: { value: 'whisper-1' } });
    fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: ' Control + Super + R ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledExactlyOnceWith(settings));
    await screen.findByText('Настройки сохранены.');
  });

  it('offers macOS auto-paste and persists the choice with an Accessibility explanation', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15',
    );
    const initial = makeSnapshot({ settings: { ...makeSnapshot().settings, paste_shortcut: 'ctrl_shift_v' } });
    await mountSettings(initial);
    expect(screen.queryByLabelText('Сочетание для вставки')).toBeNull();
    expect(screen.getByText(/для Cmd\+V/)).toBeTruthy();
    const autoPaste = screen.getByLabelText('Автоматически вставлять результат');
    expect(autoPaste).toHaveProperty('checked', false);
    expect(screen.getByText(/разрешение «Универсальный доступ»/)).toBeTruthy();
    expect(screen.getAllByText('Ctrl+Cmd+A', { selector: 'kbd' }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Сочетание клавиш озвучивания')).toHaveProperty('value', 'Control+Super+A');
    const saved = makeSnapshot({ settings: { ...initial.settings, auto_paste: true } });
    backend.saveSettings.mockResolvedValue(saved);
    backend.getSnapshot.mockResolvedValue(saved);
    fireEvent.click(autoPaste);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledWith(saved.settings));
    openHome();
    expect(screen.getByText(/автоматически вставляется в активное поле/)).toBeTruthy();
  });

  it.each(['native', 'system'] as const)('offers opt-in Linux auto-paste in %s mode and persists both choices', async (hotkey_mode) => {
    // Wayland webviews can also identify themselves as X11: use the backend mode.
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    const initial = makeSnapshot({ hotkey_mode });
    await mountSettings(initial);
    const autoPaste = screen.getByLabelText('Автоматически вставлять результат');
    expect(autoPaste).toHaveProperty('checked', false);
    const help = document.getElementById(autoPaste.getAttribute('aria-describedby')!)!;
    expect(help.textContent).toContain(hotkey_mode === 'system' ? 'Wayland: нужен ydotool' : 'X11: нужен xdotool');
    expect(help.textContent).not.toContain(hotkey_mode === 'system' ? 'xdotool' : 'ydotool');
    expect(help.textContent).not.toContain('Универсальный доступ');
    expect(help.textContent).toContain('остановленной hotkey или автоматически по лимиту');
    expect(help.textContent).toContain('Кнопка и меню трея только копируют текст');
    const pasteShortcut = screen.getByLabelText('Сочетание для вставки');
    expect(pasteShortcut).toHaveProperty('value', 'ctrl_v');
    expect(pasteShortcut.matches(':disabled')).toBe(true);
    expect(screen.getByText(/Выбор один для всех приложений/)).toBeTruthy();
    expect(help.textContent).toContain('тайм-ауте 5 секунд');
    if (hotkey_mode === 'system') {
      expect(help.textContent).toContain('демон, доступ к uinput и сокету');
      expect(help.textContent).toContain('YDOTOOL_SOCKET');
      expect(help.textContent).toContain('Ubuntu 22.04 может быть устаревшим');
    }
    fireEvent.click(autoPaste);
    expect(pasteShortcut.matches(':disabled')).toBe(false);
    // Transcript guidance follows saved settings, not an unsaved draft.
    openHome();
    expect(screen.getByText(/Текст копируется в буфер обмена —/)).toBeTruthy();
    openSettings();
    const saved = { ...initial, settings: { ...initial.settings, auto_paste: true } };
    backend.saveSettings.mockResolvedValue(saved);
    backend.getSnapshot.mockResolvedValue(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledExactlyOnceWith(saved.settings));
    openHome();
    await screen.findByText(/автоматически вставляется в активное поле на момент завершения/);
    openSettings();
    await waitFor(() => expect(autoPaste.matches(':disabled')).toBe(false));
    // Treat disabling as a separate save, outside the double-click guard.
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
    backend.saveSettings.mockResolvedValue(initial);
    backend.getSnapshot.mockResolvedValue(initial);
    fireEvent.click(autoPaste);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenLastCalledWith(initial.settings));
    openHome();
    await screen.findByText(/Текст копируется в буфер обмена —/);
  });

  it.each(['ctrl_v', 'ctrl_shift_v'] as const)('loads, edits and saves Linux paste chord %s without losing it when disabled', async (paste_shortcut) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    const initial = makeSnapshot({ settings: { ...makeSnapshot().settings, auto_paste: true, paste_shortcut } });
    await mountSettings(initial);
    const select = screen.getByLabelText('Сочетание для вставки');
    const save = screen.getByRole('button', { name: 'Сохранить настройки' });
    expect(select).toHaveProperty('value', paste_shortcut);
    expect(save).toHaveProperty('disabled', true);
    const next: Settings['paste_shortcut'] = paste_shortcut === 'ctrl_v' ? 'ctrl_shift_v' : 'ctrl_v';
    fireEvent.change(select, { target: { value: next } });
    expect(save).toHaveProperty('disabled', false);
    emit({ ...initial, recording_seconds: 1 });
    expect(select).toHaveProperty('value', next);
    fireEvent.click(screen.getByLabelText('Автоматически вставлять результат'));
    expect(select.matches(':disabled')).toBe(true);
    const saved = makeSnapshot({ settings: { ...initial.settings, auto_paste: false, paste_shortcut: next } });
    const saving = deferred<Snapshot>();
    backend.saveSettings.mockReturnValue(saving.promise);
    backend.getSnapshot.mockResolvedValue(saved);
    fireEvent.click(save);
    expect(backend.saveSettings).toHaveBeenCalledExactlyOnceWith(saved.settings);
    expect(screen.getByLabelText('Автоматически вставлять результат').matches(':disabled')).toBe(true);
    await act(async () => saving.resolve(saved));
    await screen.findByText('Настройки сохранены.');
    expect(select).toHaveProperty('value', next);
    expect(save).toHaveProperty('disabled', true);
    // A settings-only backend update must refresh the draft too.
    emit({ ...saved, settings: { ...saved.settings, paste_shortcut } });
    expect(select).toHaveProperty('value', paste_shortcut);
  });

  it.each(['recording', 'transcribing', 'polishing'] as const)('locks Linux auto-paste during %s', async (phase) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    await mountSettings(makeSnapshot({ phase, settings: { ...makeSnapshot().settings, auto_paste: true } }));
    expect(screen.getByLabelText('Автоматически вставлять результат').matches(':disabled')).toBe(true);
    expect(screen.getByLabelText('Сочетание для вставки').matches(':disabled')).toBe(true);
  });

  it.each(['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Mozilla/5.0 (Linux; Android 14)'])('hides auto-paste on unsupported platform %s', async (userAgent) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    await mountSettings(makeSnapshot({ settings: { ...makeSnapshot().settings, auto_paste: true } }));
    expect(screen.queryByLabelText('Автоматически вставлять результат')).toBeNull();
    expect(screen.queryByLabelText('Сочетание для вставки')).toBeNull();
    openHome();
    expect(screen.getByText(/Текст копируется в буфер обмена —/)).toBeTruthy();
  });

  it('saves the password transiently and clears it as soon as the backend accepts it', async () => {
    await mountSettings(makeSnapshot({ has_api_key: false }));
    const input = screen.getByLabelText('Ключ OpenAI');
    const saving = deferred<Snapshot>();
    const reconciliation = deferred<Snapshot>();
    backend.setApiKey.mockReturnValue(saving.promise);
    backend.getSnapshot.mockReturnValue(reconciliation.promise);
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    expect(input).toHaveProperty('type', 'password');
    fireEvent.change(input, { target: { value: ' test-only-key ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить ключ' }));
    expect(backend.setApiKey).toHaveBeenCalledExactlyOnceWith('test-only-key');
    await act(async () => saving.resolve(makeSnapshot()));
    expect(input).toHaveProperty('value', '');
    expect(storageWrite).not.toHaveBeenCalled();
    await act(async () => reconciliation.resolve(makeSnapshot()));
    await screen.findByText('API-ключ сохранён. Поле ввода очищено.');
  });

  it('deletes the key and clears any unsaved password', async () => {
    await mountSettings();
    const deleted = makeSnapshot({ has_api_key: false });
    backend.deleteApiKey.mockResolvedValue(deleted);
    backend.getSnapshot.mockResolvedValue(deleted);
    fireEvent.change(screen.getByLabelText('Новый ключ'), { target: { value: 'unsaved-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Удалить ключ' }));
    await screen.findByText('API-ключ удалён. Для новой записи потребуется сохранить ключ.');
    expect(backend.deleteApiKey).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Ключ OpenAI')).toHaveProperty('value', '');
    openHome();
    expect(screen.getByRole('button', { name: 'Начать запись' })).toHaveProperty('disabled', true);
  });

  it('copies the last transcript through the native clipboard command', async () => {
    await mount(makeSnapshot({ last_transcript: 'Готовый текст' }));
    backend.copyLastTranscript.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать' }));
    const feedback = await screen.findByText('Скопировано');
    expect(screen.getByRole('region', { name: 'Последний результат' }).contains(feedback)).toBe(true);
    expect(document.querySelector('.notifications')?.textContent).not.toContain('Скопировано');
    expect(backend.copyLastTranscript).toHaveBeenCalledOnce();
  });

  it('requires confirmation before resetting statistics', async () => {
    await mountSettings(makeSnapshot({ statistics: { last_recording_seconds: 12, total_recording_seconds: 12, recordings: 1 } }));
    backend.resetStatistics.mockResolvedValue(makeSnapshot());
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить' }));
    expect(backend.resetStatistics).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Да, сбросить' }));
    await screen.findByText('Статистика сброшена.');
    expect(backend.resetStatistics).toHaveBeenCalledOnce();
  });

  it('shows local validation and backend errors without hiding either', async () => {
    await mountSettings(makeSnapshot({ last_error: 'Микрофон отключён' }));
    fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: 'Super+' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(backend.saveSettings).not.toHaveBeenCalled();
    expect(screen.getByText('Проверьте настройки')).toBeTruthy();
    expect(screen.getByText('Микрофон отключён')).toBeTruthy();
    backend.toggleRecording.mockRejectedValue(new Error('Нет разрешения на микрофон'));
    openHome();
    fireEvent.click(screen.getByRole('button', { name: 'Начать запись' }));
    await screen.findByText(/Не удалось начать или остановить запись: Нет разрешения на микрофон/);
  });

  it('keeps an unavailable saved microphone selectable and exposes device-list failures', async () => {
    backend.listInputDevices.mockRejectedValue('Нет доступа к устройствам');
    await mountSettings(makeSnapshot({ settings: { ...makeSnapshot().settings, input_device: 'missing-mic' } }));
    expect(screen.getByLabelText('Микрофон')).toHaveProperty('value', 'missing-mic');
    expect(screen.getByRole('option', { name: 'Сохранённый микрофон (нет в списке)' })).toBeTruthy();
    await screen.findByText(/Не удалось получить микрофоны: Нет доступа к устройствам/);
  });

  it('offers applying a missing GNOME shortcut even when settings have not changed', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    const command = '"/opt/STT Simple/stt-simple" --toggle';
    const ttsCommand = '"/opt/STT Simple/stt-simple" --toggle-tts';
    await mountSettings(makeSnapshot({ hotkey_available: false, hotkey_mode: 'system', hotkey_command: command,
      hotkey_message: 'Системное сочетание отсутствует.', tts_hotkey_available: false,
      tts_hotkey_command: ttsCommand, tts_hotkey_message: 'Назначьте озвучивание вручную. TTS на Linux не проверен.' }));
    expect(screen.getByText(command)).toBeTruthy();
    expect(screen.getByText(ttsCommand)).toBeTruthy();
    expect(screen.getAllByText(/TTS на Linux не проверен/)).toHaveLength(2);
    expect(screen.getByText(/автоматическая регистрация GNOME применяется к диктовке и переключению обработки/i)).toBeTruthy();
    expect(screen.getByText(/не настроено в GNOME/)).toBeTruthy();
    expect(screen.queryByText(/недоступно, используйте кнопку/)).toBeNull();
    expect(screen.queryByText(/не удалось зарегистрировать/)).toBeNull();
    expect(screen.getByText(/Чужие сочетания не перезаписываются/)).toBeTruthy();
    expect(screen.getByText(/Системное сочетание отсутствует/)).toBeTruthy();
    expect(screen.getByText(/Для работы в фоне сверните окно/)).toBeTruthy();
    expect(screen.getByText(/В Linux закрытие окна тоже сворачивает его, а не скрывает в системный трей/)).toBeTruthy();
    expect(screen.getByText(/Привязка проверяется при запуске и сохранении настроек/)).toBeTruthy();
    const saved = makeSnapshot({ hotkey_available: true, hotkey_mode: 'system', hotkey_command: command });
    backend.saveSettings.mockResolvedValue(saved);
    backend.getSnapshot.mockResolvedValue(saved);
    const save = screen.getByRole('button', { name: 'Сохранить настройки' });
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(save);
    await screen.findByText('Настройки сохранены.');
    expect(backend.saveSettings).toHaveBeenCalledWith(saved.settings);
    openHome();
    expect(screen.getByText(/· настроено в GNOME/, { selector: '.shortcut-hint span' })).toBeTruthy();
  });

  it('does not show Wayland instructions on Linux with native shortcut registration', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    await mountSettings(makeSnapshot({ hotkey_mode: 'native', hotkey_available: true }));
    expect(screen.queryByRole('heading', { name: 'Системное сочетание клавиш' })).toBeNull();
    expect(screen.queryByText(/настроено в GNOME/)).toBeNull();
    openHome();
    expect(screen.getAllByText(/зарегистрировано/)).toHaveLength(2);
  });

  it('keeps the saved GNOME status and settings when applying another shortcut fails', async () => {
      const saved = makeSnapshot({ hotkey_mode: 'system', hotkey_available: true });
      await mountSettings(saved);
      backend.saveSettings.mockRejectedValue('Сочетание уже назначено другому приложению.');
      fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: 'Super+E' } });
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
      await screen.findByText(/Не удалось сохранить настройки: Сочетание уже назначено/);
      openHome();
      expect(screen.getByText(/· настроено в GNOME/, { selector: '.shortcut-hint span' })).toBeTruthy();
      expect(screen.getByText('Super+R', { selector: '.shortcut-hint kbd' })).toBeTruthy();
      openSettings();
      expect(screen.getByLabelText('Сочетание клавиш')).toHaveProperty('value', 'Super+E');
    });

    it('disables system shortcut application while recording', async () => {
      await mountSettings(makeSnapshot({ phase: 'recording', hotkey_mode: 'system', hotkey_available: false }));
      expect(screen.getByRole('button', { name: 'Сохранить настройки' }).matches(':disabled')).toBe(true);
    });

    it('distinguishes a native registration failure from the Wayland system mode', async () => {
    await mountSettings(makeSnapshot({ hotkey_mode: 'native', hotkey_available: false, hotkey_message: 'Сочетание занято.' }));
    expect(screen.getByText('Сочетание занято.')).toBeTruthy();
    openHome();
    expect(screen.getByText(/не удалось зарегистрировать/)).toBeTruthy();
    expect(screen.queryByText(/Команда для этой сборки/)).toBeNull();
  });

  it('allows choosing the current recommended transcription model', async () => {
    const settings = { ...makeSnapshot().settings, model: 'gpt-transcribe' };
    await mountSettings();
    backend.saveSettings.mockResolvedValue(makeSnapshot({ settings }));
    fireEvent.change(screen.getByLabelText('Модель'), { target: { value: 'gpt-transcribe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await screen.findByText('Настройки сохранены.');
    expect(backend.saveSettings).toHaveBeenCalledWith(settings);
  });

  it('allows a custom model ID not present in the suggestions', async () => {
    const settings = { ...makeSnapshot().settings, model: 'gpt-transcribe-future-snapshot' };
    await mountSettings();
    backend.saveSettings.mockResolvedValue(makeSnapshot({ settings }));
    fireEvent.change(screen.getByLabelText('Модель'), { target: { value: '__custom__' } });
    fireEvent.change(screen.getByLabelText('ID модели OpenAI'), { target: { value: settings.model } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await screen.findByText('Настройки сохранены.');
    expect(backend.saveSettings).toHaveBeenCalledWith(settings);
    expect(screen.getByLabelText('ID модели OpenAI')).toHaveProperty('value', settings.model);
  });

  it('allows custom TTS model and voice IDs and preserves them', async () => {
    const settings = {
      ...makeSnapshot().settings,
      tts_model: 'future-tts-snapshot',
      tts_voice: 'voice_1.0:preview',
    };
    await mountSettings();
    backend.saveSettings.mockResolvedValue(makeSnapshot({ settings }));
    fireEvent.change(screen.getByLabelText('TTS-модель'), { target: { value: '__custom__' } });
    fireEvent.change(screen.getByLabelText('ID TTS-модели OpenAI'), { target: { value: settings.tts_model } });
    fireEvent.change(screen.getByLabelText('Голос'), { target: { value: '__custom__' } });
    fireEvent.change(screen.getByLabelText('ID голоса OpenAI'), { target: { value: settings.tts_voice } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await screen.findByText('Настройки сохранены.');
    expect(backend.saveSettings).toHaveBeenCalledWith(settings);
  });

  it('preserves a combined TTS, polishing and Linux paste draft across backend settings events and saves every field', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    const initial = makeSnapshot();
    await mountSettings(initial);
    fireEvent.change(screen.getByLabelText('Голос'), { target: { value: 'cedar' } });
    fireEvent.change(screen.getByLabelText('Сочетание клавиш озвучивания'), { target: { value: ' Control + Alt + A ' } });
    fireEvent.change(screen.getByLabelText('Профиль обработки текста'), { target: { value: 'markdown' } });
    fireEvent.click(screen.getByLabelText('Автоматически вставлять результат'));
    fireEvent.change(screen.getByLabelText('Сочетание для вставки'), { target: { value: 'ctrl_shift_v' } });
    emit({ ...initial, settings: { ...initial.settings, model: 'whisper-1', tts_voice: 'alloy' } });
    expect(screen.getByLabelText('Голос')).toHaveProperty('value', 'cedar');
    expect(screen.getByLabelText('Сочетание клавиш озвучивания')).toHaveProperty('value', ' Control + Alt + A ');
    expect(screen.getByLabelText('Профиль обработки текста')).toHaveProperty('value', 'markdown');
    expect(screen.getByLabelText('Сочетание для вставки')).toHaveProperty('value', 'ctrl_shift_v');
    const settings: Settings = {
      ...initial.settings,
      tts_voice: 'cedar',
      tts_shortcut: 'Control+Alt+A',
      auto_paste: true,
      paste_shortcut: 'ctrl_shift_v',
      polish: { ...initial.settings.polish, profile_id: 'markdown' },
    };
    const saved = { ...initial, settings };
    backend.saveSettings.mockResolvedValue(saved);
    backend.getSnapshot.mockResolvedValue(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await screen.findByText('Настройки сохранены.');
    expect(backend.saveSettings).toHaveBeenCalledExactlyOnceWith(settings);
    expect(screen.getByRole('button', { name: 'Сохранить настройки' })).toHaveProperty('disabled', true);
    emit({ ...saved, settings: { ...settings, tts_voice: 'marin' } });
    expect(screen.getByLabelText('Голос')).toHaveProperty('value', 'marin');
  });

  it('rejects equivalent recording and speech shortcuts before invoking the backend', async () => {
    await mountSettings();
    fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: 'Super+Control+A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(await screen.findByText(/не должны совпадать/)).toBeTruthy();
    expect(backend.saveSettings).not.toHaveBeenCalled();
  });

  it('preserves an existing custom model while changing another setting', async () => {
    const saved = { ...makeSnapshot().settings, model: 'custom-transcription-model' };
    await mountSettings(makeSnapshot({ settings: saved }));
    expect(screen.getByLabelText('ID модели OpenAI')).toHaveProperty('value', saved.model);
    const settings = { ...saved, shortcut: 'Control+Alt+R' };
    backend.saveSettings.mockResolvedValue(makeSnapshot({ settings }));
    fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: settings.shortcut } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await screen.findByText('Настройки сохранены.');
    expect(backend.saveSettings).toHaveBeenCalledWith(settings);
  });
});

describe('settings page navigation', () => {
  it('starts on home, keeps both pages mounted and exposes all settings groups and anchors together', async () => {
    await mount(makeSnapshot({ last_transcript: 'Результат' }));
    const result = screen.getByRole('region', { name: 'Последний результат' });
    const home = result.parentElement!;
    const settings = document.getElementById('settings-page')!;
    const navigation = screen.getByRole('button', { name: 'Настройки' });
    expect(home).toHaveProperty('hidden', false);
    expect(settings).toHaveProperty('hidden', true);
    expect(navigation.getAttribute('aria-expanded')).toBe('false');
    expect(navigation.getAttribute('aria-controls')).toBe(settings.id);
    expect(screen.queryByRole('navigation', { name: 'Разделы настроек' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Микрофон' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Сохранить ключ' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Сбросить' })).toBeNull();

    openSettings();
    expect(home).toHaveProperty('hidden', true);
    expect(settings).toHaveProperty('hidden', false);
    expect(navigation.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Настройки приложения' }));
    expect(screen.queryByRole('button', { name: 'Начать запись' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Озвучить буфер' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Последний результат' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'API-ключ OpenAI' })).toBeNull();
    const nav = within(screen.getByRole('navigation', { name: 'Разделы настроек' }));
    for (const [name, href] of [
      ['Диктовка', '#dictation-settings'], ['Озвучивание', '#tts-settings-heading'],
      ['Обработка текста', '#polish-settings'], ['Подключение', '#key-heading'],
    ]) {
      expect(screen.getByRole('heading', { name })).toBeTruthy();
      expect(nav.getByRole('link', { name }).getAttribute('href')).toBe(href);
      expect(settings.contains(document.getElementById(href!.slice(1)))).toBe(true);
    }
    for (const name of ['Микрофон', 'TTS-модель', 'Профиль обработки текста']) {
      expect(screen.getByRole('combobox', { name })).toBeTruthy();
    }
    expect(screen.getByLabelText('Новый ключ')).toBeTruthy();
    const microphone = screen.getByRole('combobox', { name: 'Микрофон' });
    openHome();
    expect(home).toHaveProperty('hidden', false);
    expect(settings).toHaveProperty('hidden', true);
    expect(screen.getByRole('region', { name: 'Последний результат' })).toBe(result);
    expect(document.activeElement).toBe(navigation);
    openSettings();
    expect(screen.getByRole('combobox', { name: 'Микрофон' })).toBe(microphone);
    expect(backend.subscribe).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
  });

  it('preserves settings and password drafts across navigation and displays only saved microphone and profile summaries', async () => {
    const initial = makeSnapshot();
    initial.settings.input_device = 'mic-1';
    initial.settings.polish.profile_id = 'polish';
    await mount(initial);
    const summary = () => within(screen.getByRole('region', { name: 'Диктовка' }));
    expect(summary().getByText('USB микрофон')).toBeTruthy();
    expect(summary().getByText('Минимальная правка')).toBeTruthy();
    openSettings();
    fireEvent.change(screen.getByRole('combobox', { name: 'Микрофон' }), { target: { value: 'mic-2' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Профиль обработки текста' }), { target: { value: 'markdown' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Сочетание клавиш' }), { target: { value: 'Super+T' } });
    fireEvent.change(screen.getByLabelText('Новый ключ'), { target: { value: 'unsaved-test-key' } });
    expect(screen.getByText(/Есть несохранённые изменения. Черновик сохраняется/)).toBeTruthy();
    openHome();
    emit({ ...initial, recording_seconds: 2 });
    expect(summary().getByText('USB микрофон')).toBeTruthy();
    expect(summary().getByText('Минимальная правка')).toBeTruthy();
    expect(summary().queryByText('Гарнитура')).toBeNull();
    expect(summary().queryByText('Markdown')).toBeNull();
    expect(screen.getByLabelText('Есть несохранённые изменения')).toBeTruthy();
    expect(backend.saveSettings).not.toHaveBeenCalled();
    expect(backend.setApiKey).not.toHaveBeenCalled();
    openSettings();
    expect(screen.getByRole('combobox', { name: 'Микрофон' })).toHaveProperty('value', 'mic-2');
    expect(screen.getByRole('combobox', { name: 'Профиль обработки текста' })).toHaveProperty('value', 'markdown');
    expect(screen.getByRole('textbox', { name: 'Сочетание клавиш' })).toHaveProperty('value', 'Super+T');
    expect(screen.getByLabelText('Новый ключ')).toHaveProperty('value', 'unsaved-test-key');
    const saved = makeSnapshot({ settings: {
      ...initial.settings, input_device: 'mic-2', shortcut: 'Super+T',
      polish: { ...initial.settings.polish, profile_id: 'markdown' },
    } });
    backend.saveSettings.mockResolvedValue(saved);
    backend.getSnapshot.mockResolvedValue(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await screen.findByText('Настройки сохранены.');
    expect(backend.saveSettings).toHaveBeenCalledExactlyOnceWith(saved.settings);
    expect(screen.queryByLabelText('Есть несохранённые изменения')).toBeNull();
    openHome();
    expect(summary().getByText('Гарнитура')).toBeTruthy();
    expect(summary().getByText('Markdown')).toBeTruthy();
    expect(summary().queryByText('USB микрофон')).toBeNull();
    expect(summary().queryByText('Минимальная правка')).toBeNull();
  });

  it('keeps statistics shared, but reset and its confirmation available only on settings', async () => {
    const initial = makeSnapshot({ statistics: { last_recording_seconds: 65, total_recording_seconds: 3661, recordings: 3 } });
    await mount(initial);
    const statistics = screen.getByRole('region', { name: 'Статистика' });
    expect(within(statistics).getByText('01:05')).toBeTruthy();
    expect(within(statistics).getByText('01:01:01')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Сбросить' })).toBeNull();
    openSettings();
    expect(screen.getByRole('region', { name: 'Статистика' })).toBe(statistics);
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить' }));
    expect(screen.getByRole('group', { name: 'Сбросить длительность и количество записей?' })).toBeTruthy();
    openHome();
    expect(screen.queryByRole('button', { name: 'Да, сбросить' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Сбросить' })).toBeNull();
    expect(backend.resetStatistics).not.toHaveBeenCalled();
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Не сбрасывать' }));
    expect(screen.queryByRole('button', { name: 'Да, сбросить' })).toBeNull();
    expect(within(statistics).getByText('3')).toBeTruthy();
    expect(backend.resetStatistics).not.toHaveBeenCalled();
  });
});

describe('transcript result regressions', () => {
  it('shows an empty read-only final field without disclosure, retry or previous result', async () => {
    await mount();
    const result = within(screen.getByRole('region', { name: 'Последний результат' }));
    const final = result.getByRole('textbox', { name: 'Текст последней диктовки' });
    expect(final).toHaveProperty('value', '');
    expect(final).toHaveProperty('readOnly', true);
    expect(final.getAttribute('placeholder')).toBe('Начните диктовку — здесь появится готовый текст.');
    expect(result.getByRole('button', { name: 'Скопировать' })).toHaveProperty('disabled', true);
    expect(result.queryByRole('button', { name: 'Показать исходный текст' })).toBeNull();
    expect(result.queryByRole('button', { name: 'Скопировать исходный' })).toBeNull();
    expect(result.queryByRole('button', { name: 'Повторить обработку текста' })).toBeNull();
    expect(result.queryByText('Предыдущий успешный результат')).toBeNull();
  });

  it('shows final by default and toggles raw using an accessible disclosure without changing final', async () => {
    await mount(makeSnapshot({ last_transcript: 'Итоговый текст', last_raw_transcript: 'исходная расшифровка' }));
    const final = screen.getByRole('textbox', { name: 'Текст последней диктовки' });
    const disclosure = screen.getByRole('button', { name: 'Показать исходный текст' });
    const content = document.getElementById(disclosure.getAttribute('aria-controls')!)!;
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(content).toHaveProperty('hidden', true);
    expect(screen.queryByRole('textbox', { name: 'Исходный текст распознавания' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Скопировать исходный' })).toBeNull();
    fireEvent.click(disclosure);
    expect(screen.getByRole('button', { name: 'Скрыть исходный текст' })).toBe(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(content).toHaveProperty('hidden', false);
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'исходная расшифровка');
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('readOnly', true);
    expect(screen.getByRole('button', { name: 'Скопировать исходный' })).toHaveProperty('disabled', false);
    expect(final).toHaveProperty('value', 'Итоговый текст');
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(content).toHaveProperty('hidden', true);
    expect(screen.queryByRole('textbox', { name: 'Исходный текст распознавания' })).toBeNull();
    expect(final).toHaveProperty('value', 'Итоговый текст');
  });

  it.each([null, 'Старый успешный текст'])('automatically exposes failed raw and separates previous final (%j)', async (previous) => {
    await mount(makeSnapshot({
      last_transcript: null, previous_transcript: previous,
      last_raw_transcript: 'Новая неудавшаяся расшифровка', can_retry_polish: true,
    }));
    const warning = screen.getByText('Обработка текста не завершена');
    expect(warning.closest('[role="status"]')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Новая неудавшаяся расшифровка');
    expect(document.getElementById('raw-result-content')).toHaveProperty('hidden', false);
    expect(screen.queryByRole('button', { name: 'Показать исходный текст' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Текст последней диктовки' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Скопировать' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Скопировать исходный' })).toHaveProperty('disabled', false);
    if (previous) {
      const disclosure = screen.getByText('Предыдущий успешный результат', { selector: 'summary' });
      expect(disclosure.parentElement).toHaveProperty('open', false);
      fireEvent.click(disclosure);
      expect(disclosure.parentElement).toHaveProperty('open', true);
      expect(screen.getByRole('textbox', { name: 'Предыдущий успешный текст' })).toHaveProperty('value', previous);
      expect(screen.getByRole('textbox', { name: 'Предыдущий успешный текст' })).toHaveProperty('readOnly', true);
      expect(screen.getByText('Это результат предыдущей записи, а не текущей расшифровки.')).toBeTruthy();
    } else {
      expect(screen.queryByText('Предыдущий успешный результат')).toBeNull();
      expect(screen.queryByRole('textbox', { name: 'Предыдущий успешный текст' })).toBeNull();
    }
  });

  it('preserves A as previous while B polishes, fails, survives TTS and succeeds after retry', async () => {
    const a = makeSnapshot({ last_transcript: 'Итог A', last_raw_transcript: 'Расшифровка A' });
    await mount(a);
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', 'Итог A');
    expect(screen.queryByText('Предыдущий успешный результат')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Повторить обработку текста' })).toBeNull();

    emit({ ...a, phase: 'recording' });
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', 'Итог A');
    expect(screen.getByText('Показан предыдущий успешный результат. Новая запись ещё не распознана.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Скопировать' })).toHaveProperty('disabled', true);
    expect(screen.queryByText('Предыдущий успешный результат')).toBeNull();
    emit({ ...a, phase: 'transcribing' });
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', 'Итог A');
    expect(screen.getByText('Распознаём новую запись…')).toBeTruthy();

    const polishing = makeSnapshot({
      phase: 'polishing', last_transcript: null, previous_transcript: 'Итог A',
      last_raw_transcript: 'Расшифровка B', has_pending_polish: true, can_retry_polish: false,
    });
    emit(polishing);
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: 'Скопировать' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Обрабатываем исходную расшифровку…')).toBeTruthy();
    expect(screen.queryByText('Обработка текста не завершена')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Расшифровка B');
    expect(document.getElementById('raw-result-content')).toHaveProperty('hidden', false);
    expect(screen.queryByRole('button', { name: 'Показать исходный текст' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Скопировать исходный' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Повторить обработку текста' })).toHaveProperty('disabled', true);
    const previous = screen.getByText('Предыдущий успешный результат', { selector: 'summary' });
    expect(previous.parentElement).toHaveProperty('open', false);
    fireEvent.click(previous);
    expect(screen.getByRole('textbox', { name: 'Предыдущий успешный текст' })).toHaveProperty('value', 'Итог A');

    const failed: Snapshot = {
      ...polishing, phase: 'idle', can_retry_polish: true, last_error: 'Обработка B не удалась',
    };
    emit(failed);
    expect(screen.getByText('Обработка текста не завершена')).toBeTruthy();
    expect(screen.getByText('Обработка B не удалась')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Текст последней диктовки' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Скопировать' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Расшифровка B');
    expect(screen.getByRole('textbox', { name: 'Предыдущий успешный текст' })).toHaveProperty('value', 'Итог A');
    expect(screen.getByRole('button', { name: 'Скопировать исходный' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Повторить обработку текста' })).toHaveProperty('disabled', false);

    for (const phase of ['synthesizing', 'playing'] as const) {
      emit({ ...failed, phase, can_retry_polish: false });
      expect(screen.getByText('Обработка текста не завершена')).toBeTruthy();
      expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Расшифровка B');
      expect(screen.getByRole('textbox', { name: 'Предыдущий успешный текст' })).toHaveProperty('value', 'Итог A');
      expect(screen.queryByRole('textbox', { name: 'Текст последней диктовки' })).toBeNull();
      expect(document.getElementById('raw-result-content')).toHaveProperty('hidden', false);
      for (const name of ['Скопировать исходный', 'Повторить обработку текста']) {
        const button = screen.getByRole('button', { name });
        expect(button).toHaveProperty('disabled', true);
        fireEvent.click(button);
      }
      expect(backend.copyLastRawTranscript).not.toHaveBeenCalled();
      expect(backend.retryPolish).not.toHaveBeenCalled();
    }

    emit(failed);
    const retry = deferred<void>();
    backend.retryPolish.mockReturnValue(retry.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить обработку текста' }));
    expect(backend.retryPolish).toHaveBeenCalledExactlyOnceWith();
    emit(polishing);
    expect(screen.queryByText('Обработка текста не завершена')).toBeNull();
    expect(screen.getByText('Обрабатываем исходную расшифровку…')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', '');
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Расшифровка B');
    expect(document.getElementById('raw-result-content')).toHaveProperty('hidden', false);
    expect(screen.queryByRole('button', { name: 'Показать исходный текст' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Предыдущий успешный текст' })).toHaveProperty('value', 'Итог A');
    expect(screen.getByRole('button', { name: 'Повтор…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Скопировать исходный' })).toHaveProperty('disabled', true);

    const success: Snapshot = {
      ...polishing, phase: 'idle', last_transcript: 'Итог B', previous_transcript: null,
      has_pending_polish: false, can_retry_polish: false, last_error: null,
    };
    backend.getSnapshot.mockResolvedValue(success);
    await act(async () => retry.resolve());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Скопировать' })).toHaveProperty('disabled', false));
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', 'Итог B');
    expect(screen.queryByText('Предыдущий успешный результат')).toBeNull();
    expect(screen.queryByText('Обработка текста не завершена')).toBeNull();
    expect(screen.queryByRole('button', { name: /Повторить обработку текста|Повтор…/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Исходный текст распознавания' })).toBeNull();
    const disclosure = screen.getByRole('button', { name: 'Показать исходный текст' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(disclosure);
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Расшифровка B');
    expect(backend.copyLastTranscript).not.toHaveBeenCalled();
    expect(backend.copyLastRawTranscript).not.toHaveBeenCalled();
    expect(backend.saveSettings).not.toHaveBeenCalled();
  });

  it('copies raw with its own backend command and local feedback, locking through reconciliation', async () => {
    const snapshot = makeSnapshot({ last_transcript: 'Итог', last_raw_transcript: 'Исходный' });
    await mount(snapshot);
    fireEvent.click(screen.getByRole('button', { name: 'Показать исходный текст' }));
    const copying = deferred<void>();
    const reconciliation = deferred<Snapshot>();
    backend.copyLastRawTranscript.mockReturnValue(copying.promise);
    backend.getSnapshot.mockReturnValue(reconciliation.promise);
    const copy = screen.getByRole('button', { name: 'Скопировать исходный' });
    act(() => { fireEvent.click(copy); fireEvent.click(copy); });
    expect(backend.copyLastRawTranscript).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole('button', { name: 'Копирование исходного…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Скопировать' })).toHaveProperty('disabled', true);
    await act(async () => copying.resolve());
    expect(copy).toHaveProperty('disabled', true);
    expect(screen.queryByText('Исходный текст скопирован')).toBeNull();
    await act(async () => reconciliation.resolve(snapshot));
    const feedback = await screen.findByText('Исходный текст скопирован');
    expect(screen.getByRole('region', { name: 'Последний результат' }).contains(feedback)).toBe(true);
    expect(document.querySelector('.notifications')?.textContent).not.toContain('Исходный текст скопирован');
    expect(copy).toHaveProperty('disabled', false);
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', 'Итог');
    expect(backend.copyLastTranscript).not.toHaveBeenCalled();
    expect(backend.retryPolish).not.toHaveBeenCalled();
  });

  it('allows copying failed raw without an API key while preserving the previous successful result', async () => {
    await mount(makeSnapshot({
      has_api_key: false, can_retry_polish: true,
      last_transcript: null, previous_transcript: 'Предыдущий итог', last_raw_transcript: 'Текущая расшифровка',
    }));
    backend.copyLastRawTranscript.mockResolvedValue(undefined);
    const copy = screen.getByRole('button', { name: 'Скопировать исходный' });
    expect(copy).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Повторить обработку текста' })).toHaveProperty('disabled', true);
    fireEvent.click(copy);
    await screen.findByText('Исходный текст скопирован');
    expect(backend.copyLastRawTranscript).toHaveBeenCalledExactlyOnceWith();
    expect(backend.copyLastTranscript).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Текст последней диктовки' })).toBeNull();
    fireEvent.click(screen.getByText('Предыдущий успешный результат', { selector: 'summary' }));
    expect(screen.getByRole('textbox', { name: 'Предыдущий успешный текст' })).toHaveProperty('value', 'Предыдущий итог');
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Текущая расшифровка');
  });

  it('reports raw clipboard errors without success feedback or replacing either text', async () => {
    await mount(makeSnapshot({ last_transcript: 'Итог', last_raw_transcript: 'Исходный' }));
    fireEvent.click(screen.getByRole('button', { name: 'Показать исходный текст' }));
    backend.copyLastRawTranscript.mockRejectedValue(new Error('Буфер недоступен'));
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать исходный' }));
    await screen.findByText(/Не удалось скопировать исходный текст: Буфер недоступен/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Скопировать исходный' })).toHaveProperty('disabled', false));
    expect(backend.copyLastRawTranscript).toHaveBeenCalledExactlyOnceWith();
    expect(backend.copyLastTranscript).not.toHaveBeenCalled();
    expect(screen.queryByText('Исходный текст скопирован')).toBeNull();
    expect(screen.queryByText('Скопировано')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Исходный');
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', 'Итог');
  });

  it.each(['recording', 'transcribing', 'polishing', 'synthesizing', 'playing'] as const)('guards raw copy during %s and restores it at idle', async (phase) => {
    const idle = makeSnapshot({ last_raw_transcript: 'Исходный' });
    await mount(idle);
    fireEvent.click(screen.getByRole('button', { name: 'Показать исходный текст' }));
    const copy = screen.getByRole('button', { name: 'Скопировать исходный' });
    expect(copy).toHaveProperty('disabled', false);
    emit({ ...idle, phase });
    expect(copy).toHaveProperty('disabled', true);
    fireEvent.click(copy);
    expect(backend.copyLastRawTranscript).not.toHaveBeenCalled();
    emit(idle);
    expect(copy).toHaveProperty('disabled', false);
  });

  it.each(['final', 'raw'] as const)('clears local %s copy feedback when new text arrives', async (kind) => {
    const snapshot = makeSnapshot({ last_transcript: 'Первый итог', last_raw_transcript: 'Первый исходный' });
    await mount(snapshot);
    backend.copyLastTranscript.mockResolvedValue(undefined);
    backend.copyLastRawTranscript.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Показать исходный текст' }));
    fireEvent.click(screen.getByRole('button', { name: kind === 'final' ? 'Скопировать' : 'Скопировать исходный' }));
    await screen.findByText(kind === 'final' ? 'Скопировано' : 'Исходный текст скопирован');
    emit({ ...snapshot, last_transcript: 'Второй итог', last_raw_transcript: 'Второй исходный' });
    expect(screen.queryByText('Скопировано')).toBeNull();
    expect(screen.queryByText('Исходный текст скопирован')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', 'Второй итог');
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Второй исходный');
  });

  it.each([
    { kind: 'final', during: 'command' },
    { kind: 'raw', during: 'command' },
    { kind: 'final', during: 'reconciliation' },
    { kind: 'raw', during: 'reconciliation' },
  ] as const)('does not revive stale $kind copy feedback when a new result arrives during $during', async ({ kind, during }) => {
    const initial = makeSnapshot({ last_transcript: 'Итог A', last_raw_transcript: 'Расшифровка A' });
    const newer = makeSnapshot({ last_transcript: 'Итог B', last_raw_transcript: 'Расшифровка B' });
    await mount(initial);
    fireEvent.click(screen.getByRole('button', { name: 'Показать исходный текст' }));
    const copying = deferred<void>();
    const reconciliation = deferred<Snapshot>();
    const command = kind === 'final' ? backend.copyLastTranscript : backend.copyLastRawTranscript;
    const name = kind === 'final' ? 'Скопировать' : 'Скопировать исходный';
    command.mockReturnValue(copying.promise);
    backend.getSnapshot.mockReturnValue(reconciliation.promise);
    const reads = backend.getSnapshot.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name }));
    expect(command).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole('button', { name: kind === 'final' ? 'Копирование…' : 'Копирование исходного…' })).toHaveProperty('disabled', true);

    if (during === 'command') emit(newer);
    await act(async () => copying.resolve());
    expect(backend.getSnapshot).toHaveBeenCalledTimes(reads + 1);
    if (during === 'reconciliation') emit(newer);
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', 'Итог B');
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Расшифровка B');
    expect(screen.queryByText('Скопировано')).toBeNull();
    expect(screen.queryByText('Исходный текст скопирован')).toBeNull();

    // A newer event must also supersede an older reconciliation read already in flight.
    await act(async () => reconciliation.resolve(during === 'reconciliation' ? initial : newer));
    await waitFor(() => expect(screen.getByRole('button', { name })).toHaveProperty('disabled', false));
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', 'Итог B');
    expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Расшифровка B');
    expect(screen.queryByText('Скопировано')).toBeNull();
    expect(screen.queryByText('Исходный текст скопирован')).toBeNull();
    expect(command).toHaveBeenCalledTimes(1);
    expect(kind === 'final' ? backend.copyLastRawTranscript : backend.copyLastTranscript).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'final', change: 'phase' },
    { kind: 'raw', change: 'phase' },
    { kind: 'final', change: 'connection' },
    { kind: 'raw', change: 'connection' },
  ] as const)('does not revive stale $kind copy feedback after a $change change without new text', async ({ kind, change }) => {
    const snapshot = makeSnapshot({ last_transcript: 'Итог', last_raw_transcript: 'Исходный' });
    const copying = deferred<boolean>();
    const runAction = vi.fn().mockReturnValue(copying.promise);
    const props = { snapshot, connected: true, pending: null, runAction, autoPaste: false, mac: false, linux: true };
    const app = render(<TranscriptResult {...props} />);
    if (kind === 'raw') fireEvent.click(screen.getByRole('button', { name: 'Показать исходный текст' }));
    fireEvent.click(screen.getByRole('button', { name: kind === 'final' ? 'Скопировать' : 'Скопировать исходный' }));
    expect(runAction).toHaveBeenCalledExactlyOnceWith(
      kind === 'final' ? 'copy_last_transcript' : 'copy_last_raw_transcript',
      kind === 'final' ? backend.copyLastTranscript : backend.copyLastRawTranscript,
    );
    app.rerender(<TranscriptResult {...props}
      snapshot={change === 'phase' ? { ...snapshot, phase: 'synthesizing' } : snapshot}
      connected={change !== 'connection'} />);
    expect(screen.getByRole('button', { name: kind === 'final' ? 'Скопировать' : 'Скопировать исходный' })).toHaveProperty('disabled', true);
    await act(async () => copying.resolve(true));
    expect(screen.queryByText('Скопировано')).toBeNull();
    expect(screen.queryByText('Исходный текст скопирован')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Текст последней диктовки' })).toHaveProperty('value', 'Итог');
    if (kind === 'raw') expect(screen.getByRole('textbox', { name: 'Исходный текст распознавания' })).toHaveProperty('value', 'Исходный');
  });

  it.each([
    { connected: false, pending: null },
    { connected: true, pending: 'save_settings' as Action },
    { connected: true, pending: 'toggle_speech' as Action },
    { connected: true, pending: 'copy_last_raw_transcript' as Action },
  ])('guards result actions while connected=$connected pending=$pending', ({ connected, pending }) => {
    const runAction = vi.fn();
    const snapshot = makeSnapshot({ last_transcript: 'Итог', last_raw_transcript: 'Исходный' });
    const props = { connected, pending, runAction, autoPaste: false, mac: false, linux: true };
    const app = render(<TranscriptResult {...props} snapshot={snapshot} />);
    fireEvent.click(screen.getByRole('button', { name: 'Показать исходный текст' }));
    for (const button of screen.getAllByRole('button', { name: /Скопировать|Копирование/ })) {
      expect(button).toHaveProperty('disabled', true);
      fireEvent.click(button);
    }
    app.rerender(<TranscriptResult {...props} snapshot={{
      ...snapshot, last_transcript: null, previous_transcript: snapshot.last_transcript,
      can_retry_polish: true, has_pending_polish: true,
    }} />);
    const retry = screen.getByRole('button', { name: 'Повторить обработку текста' });
    expect(retry).toHaveProperty('disabled', true);
    fireEvent.click(retry);
    expect(runAction).not.toHaveBeenCalled();
    expect(backend.copyLastRawTranscript).not.toHaveBeenCalled();
    expect(backend.copyLastTranscript).not.toHaveBeenCalled();
    expect(backend.retryPolish).not.toHaveBeenCalled();
  });
});

describe('state hook synchronization', () => {
  it('has one live subscription under StrictMode and none after unmount', async () => {
    const app = renderHook(useAppState, { wrapper: StrictMode });
    await waitFor(() => expect(app.result.current.snapshot).not.toBeNull());
    expect(backend.subscribe).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
    expect(backend.getSnapshot).toHaveBeenCalledOnce();
    app.unmount();
    expect(listeners.size).toBe(0);
  });

  it('retains the command lock through reconciliation even when the backend emits no event', async () => {
    const app = renderHook(useAppState);
    await waitFor(() => expect(app.result.current.snapshot).not.toBeNull());
    const reconciliation = deferred<Snapshot>();
    backend.getSnapshot.mockReturnValue(reconciliation.promise);
    backend.toggleRecording.mockResolvedValue(undefined);
    let action!: Promise<boolean>;
    await act(async () => {
      action = app.result.current.runAction('toggle_recording', backend.toggleRecording);
    });
    expect(app.result.current.pending).toBe('toggle_recording');
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
    await act(async () => {
      expect(await app.result.current.runAction('toggle_recording', backend.toggleRecording)).toBe(false);
    });
    expect(backend.toggleRecording).toHaveBeenCalledOnce();
    await act(async () => {
      reconciliation.resolve(makeSnapshot({ phase: 'recording' }));
      expect(await action).toBe(true);
    });
    expect(app.result.current.snapshot?.phase).toBe('recording');
    expect(app.result.current.pending).toBeNull();
  });

  it('polls every second only while recording, never overlapping or overwriting a newer event', async () => {
    vi.useFakeTimers();
    const app = renderHook(useAppState);
    await act(async () => {});
    expect(backend.getSnapshot).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(backend.getSnapshot).toHaveBeenCalledOnce();
    emit(makeSnapshot({ phase: 'recording' }));
    const polling = deferred<Snapshot>();
    backend.getSnapshot.mockReturnValueOnce(polling.promise);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(backend.getSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(backend.getSnapshot).toHaveBeenCalledTimes(2);
    emit(makeSnapshot({ phase: 'transcribing' }));
    await act(async () => polling.resolve(makeSnapshot({ phase: 'recording', recording_seconds: 2 })));
    expect(app.result.current.snapshot?.phase).toBe('transcribing');
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(backend.getSnapshot).toHaveBeenCalledTimes(2);

    emit(makeSnapshot({ phase: 'recording', recording_seconds: 8 }));
    backend.getSnapshot.mockResolvedValue(makeSnapshot({ phase: 'recording', recording_seconds: 9 }));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(app.result.current.snapshot?.recording_seconds).toBe(9);
    app.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(backend.getSnapshot).toHaveBeenCalledTimes(3);
  });

  it('starts polling after listen resolves when a recording event arrived during subscription', async () => {
    vi.useFakeTimers();
    const subscription = deferred<() => void>();
    backend.subscribe.mockImplementationOnce((callback: (snapshot: Snapshot) => void) => {
      listeners.add(callback);
      return subscription.promise;
    });
    const recording = makeSnapshot({ phase: 'recording', recording_seconds: 2 });
    backend.getSnapshot.mockResolvedValue(recording);
    const app = renderHook(useAppState);
    emit(recording);
    expect(app.result.current.connected).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(backend.getSnapshot).not.toHaveBeenCalled();
    await act(async () => subscription.resolve(() => listeners.clear()));
    expect(app.result.current.connected).toBe(true);
    expect(backend.getSnapshot).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(backend.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('ignores old device results when reconnecting', async () => {
    const firstList = deferred<[]>();
    backend.listInputDevices.mockReturnValueOnce(firstList.promise);
    const app = renderHook(useAppState);
    await waitFor(() => expect(app.result.current.devicesLoading).toBe(true));
    act(() => app.result.current.retry());
    await waitFor(() => expect(app.result.current.devices).toHaveLength(2));
    await act(async () => firstList.resolve([]));
    expect(app.result.current.devices).toHaveLength(2);
    expect(listeners.size).toBe(1);
  });
});
