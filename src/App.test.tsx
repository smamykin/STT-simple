// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useAppState } from './useAppState';
import { deferred, makeSnapshot } from './testFixtures';
import type { Settings, Snapshot } from './types';
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
  retryPolish: vi.fn(),
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
  await waitFor(() => expect(screen.getByLabelText('Сочетание клавиш')).toHaveProperty('value', snapshot.settings.shortcut));
  return app;
}

beforeEach(() => {
  vi.resetAllMocks();
  listeners.clear();
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
    await mount();
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
    const app = await mount();
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
    expect(refreshModels().matches(':disabled')).toBe(true);
    fireEvent.click(refreshModels());
    expect(backend.listOpenAiModels).not.toHaveBeenCalled();
  });

  it('allows manual IDs without a key and inherits busy disabling', async () => {
    const snapshot = makeSnapshot({ has_api_key: false });
    await mount(snapshot);
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
    await mount(snapshot);
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
    await mount(snapshot);
    expect(screen.getByLabelText('ID модели обработки OpenAI')).toHaveProperty('value', 'gpt-5-mini');
    expect(screen.getByLabelText('Уровень рассуждения')).toHaveProperty('value', 'minimal');
    expect(screen.getByText(/\/models не содержит метаданных/)).toBeTruthy();
    expect(Array.from((screen.getByLabelText('Уровень рассуждения') as HTMLSelectElement).options).map((option) => option.value))
      .toEqual(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
  it('loads builtin profiles from the snapshot and keeps their instructions immutable', async () => {
    const snapshot = makeSnapshot();
    snapshot.builtin_polish_profiles[0] = { id: 'polish', name: 'Правка из core', instruction: 'Инструкция из core' };
    await mount(snapshot);
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

  it('creates, edits and deletes custom profiles only through the existing settings save', async () => {
    let snapshot = makeSnapshot();
    await mount(snapshot);
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
    expect(snapshot.settings.polish.custom_profiles).toEqual([{ id, name: 'Мой профиль', instruction: 'Сохрани\nвсе детали.' }]);
    expect(snapshot.settings.polish.profile_id).toBe(id);
    fireEvent.change(screen.getByLabelText('Название профиля'), { target: { value: 'Правка' } });
    fireEvent.change(screen.getByLabelText('Инструкция профиля'), { target: { value: 'Новая инструкция' } });
    // Even a settings-changing state event must not discard a dirty form.
    emit({ ...snapshot, settings: { ...snapshot.settings, model: 'whisper-1' } });
    expect(screen.getByLabelText('Название профиля')).toHaveProperty('value', 'Правка');
    expect(screen.getByLabelText('Инструкция профиля')).toHaveProperty('value', 'Новая инструкция');
    await save();
    expect(snapshot.settings.polish.custom_profiles).toEqual([{ id, name: 'Правка', instruction: 'Новая инструкция' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Удалить профиль' }));
    expect(screen.getByLabelText('Профиль обработки текста')).toHaveProperty('value', '');
    expect(snapshot.settings.polish.custom_profiles).toHaveLength(1);
    await save();
    expect(snapshot.settings.polish).toEqual({ profile_id: null, model: 'gpt-6-luna', effort: null, custom_profiles: [] });
    expect(backend.saveSettings).toHaveBeenCalledTimes(3);
  });

  it.each(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])('saves a custom model and effort %j without resetting the draft on state events', async (effort) => {
    const initial = makeSnapshot();
    await mount(initial);
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
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Создать профиль' }));
    fireEvent.change(screen.getByLabelText('Профиль обработки текста'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(await screen.findByText(/должны быть название и инструкция/)).toBeTruthy();
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
    const initial = makeSnapshot({ last_raw_transcript: 'сырой текст', last_transcript: 'Предыдущий успех', can_retry_polish: true });
    await mount(initial);
    expect(screen.getByLabelText('Исходный текст распознавания')).toHaveProperty('value', 'сырой текст');
    expect(screen.getByLabelText('Текст последней диктовки')).toHaveProperty('value', 'Предыдущий успех');
    fireEvent.change(screen.getByLabelText('Профиль обработки текста'), { target: { value: 'markdown' } });
    expect(screen.getByText(/Повтор использует настройки неудавшейся задачи/)).toBeTruthy();
    const retry = deferred<void>();
    backend.retryPolish.mockReturnValue(retry.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить обработку текста' }));
    expect(backend.retryPolish).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole('button', { name: 'Повтор…' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Профиль обработки текста').matches(':disabled')).toBe(true);
    expect(backend.saveSettings).not.toHaveBeenCalled();
    expect(backend.copyLastTranscript).not.toHaveBeenCalled();
    const success = { ...initial, can_retry_polish: false, last_transcript: 'Готовый результат' };
    backend.getSnapshot.mockResolvedValue(success);
    await act(async () => retry.resolve());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Повторить обработку текста' })).toBeNull());
    expect(screen.getByLabelText('Текст последней диктовки')).toHaveProperty('value', 'Готовый результат');
    expect(screen.getByLabelText('Профиль обработки текста')).toHaveProperty('value', 'markdown');
  });

  it.each(['recording', 'transcribing', 'polishing', 'synthesizing', 'playing', 'no-key', 'unavailable'] as const)('does not allow retry in %s', async (state) => {
    await mount(makeSnapshot({
      phase: state === 'no-key' || state === 'unavailable' ? 'idle' : state,
      can_retry_polish: state !== 'unavailable', has_api_key: state !== 'no-key',
      last_raw_transcript: 'Текст',
    }));
    const button = screen.queryByRole('button', { name: 'Повторить обработку текста' });
    if (state === 'unavailable') expect(button).toBeNull();
    else expect(button).toHaveProperty('disabled', true);
    expect(backend.retryPolish).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Текст последней диктовки')).toHaveProperty('value', '');
  });

  it.each(['recording', 'transcribing', 'polishing', 'synthesizing', 'playing'] as const)('locks custom profile editing during %s', async (phase) => {
    const snapshot = makeSnapshot({ phase });
    snapshot.settings.polish = { ...snapshot.settings.polish, profile_id: 'custom-test',
      custom_profiles: [{ id: 'custom-test', name: 'Профиль', instruction: 'Инструкция' }] };
    await mount(snapshot);
    for (const label of ['Название профиля', 'Инструкция профиля']) {
      expect(screen.getByLabelText(label).matches(':disabled')).toBe(true);
    }
    for (const name of ['Создать профиль', 'Дублировать профиль', 'Удалить профиль']) {
      expect(screen.getByRole('button', { name }).matches(':disabled')).toBe(true);
    }
  });

  it('reports retry errors without replacing the last successful text', async () => {
    await mount(makeSnapshot({ can_retry_polish: true, last_transcript: 'Успех', last_raw_transcript: 'Исходный' }));
    backend.retryPolish.mockRejectedValue(new Error('OpenAI недоступен'));
    fireEvent.click(screen.getByRole('button', { name: 'Повторить обработку текста' }));
    await screen.findByText(/Не удалось повторить обработку текста: OpenAI недоступен/);
    expect(screen.getByLabelText('Текст последней диктовки')).toHaveProperty('value', 'Успех');
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
    for (const label of ['Микрофон', 'Модель', 'Сочетание клавиш', 'TTS-модель', 'Голос', 'Сочетание клавиш озвучивания', 'Новый ключ', 'Профиль обработки текста', 'Модель обработки текста', 'Уровень рассуждения']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).matches(':disabled')).toBe(true);
    }
    expect(screen.getByRole('button', { name: 'Сбросить' })).toHaveProperty('disabled', true);
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
    await mount(original);
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
    await mount(initial);
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
    expect(screen.getByText(/автоматически вставляется в активное поле/)).toBeTruthy();
  });

  it.each(['native', 'system'] as const)('offers opt-in Linux auto-paste in %s mode and persists both choices', async (hotkey_mode) => {
    // Wayland webviews can also identify themselves as X11: use the backend mode.
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    const initial = makeSnapshot({ hotkey_mode });
    await mount(initial);
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
    expect(screen.getByText(/Текст копируется в буфер обмена —/)).toBeTruthy();
    const saved = { ...initial, settings: { ...initial.settings, auto_paste: true } };
    backend.saveSettings.mockResolvedValue(saved);
    backend.getSnapshot.mockResolvedValue(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledExactlyOnceWith(saved.settings));
    await screen.findByText(/автоматически вставляется в активное поле на момент завершения/);
    await waitFor(() => expect(autoPaste.matches(':disabled')).toBe(false));
    // Treat disabling as a separate save, outside the double-click guard.
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
    backend.saveSettings.mockResolvedValue(initial);
    backend.getSnapshot.mockResolvedValue(initial);
    fireEvent.click(autoPaste);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenLastCalledWith(initial.settings));
    await screen.findByText(/Текст копируется в буфер обмена —/);
  });

  it.each(['ctrl_v', 'ctrl_shift_v'] as const)('loads, edits and saves Linux paste chord %s without losing it when disabled', async (paste_shortcut) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    const initial = makeSnapshot({ settings: { ...makeSnapshot().settings, auto_paste: true, paste_shortcut } });
    await mount(initial);
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
    await mount(makeSnapshot({ phase, settings: { ...makeSnapshot().settings, auto_paste: true } }));
    expect(screen.getByLabelText('Автоматически вставлять результат').matches(':disabled')).toBe(true);
    expect(screen.getByLabelText('Сочетание для вставки').matches(':disabled')).toBe(true);
  });

  it.each(['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Mozilla/5.0 (Linux; Android 14)'])('hides auto-paste on unsupported platform %s', async (userAgent) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    await mount(makeSnapshot({ settings: { ...makeSnapshot().settings, auto_paste: true } }));
    expect(screen.queryByLabelText('Автоматически вставлять результат')).toBeNull();
    expect(screen.queryByLabelText('Сочетание для вставки')).toBeNull();
    expect(screen.getByText(/Текст копируется в буфер обмена —/)).toBeTruthy();
  });

  it('saves the password transiently and clears it as soon as the backend accepts it', async () => {
    await mount(makeSnapshot({ has_api_key: false }));
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
    await mount();
    const deleted = makeSnapshot({ has_api_key: false });
    backend.deleteApiKey.mockResolvedValue(deleted);
    backend.getSnapshot.mockResolvedValue(deleted);
    fireEvent.change(screen.getByLabelText('Новый ключ'), { target: { value: 'unsaved-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Удалить ключ' }));
    await screen.findByText('API-ключ удалён. Для новой записи потребуется сохранить ключ.');
    expect(backend.deleteApiKey).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Ключ OpenAI')).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: 'Начать запись' })).toHaveProperty('disabled', true);
  });

  it('copies the last transcript through the native clipboard command', async () => {
    await mount(makeSnapshot({ last_transcript: 'Готовый текст' }));
    backend.copyLastTranscript.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать' }));
    await screen.findByText('Текст скопирован в буфер обмена.');
    expect(backend.copyLastTranscript).toHaveBeenCalledOnce();
  });

  it('requires confirmation before resetting statistics', async () => {
    await mount(makeSnapshot({ statistics: { last_recording_seconds: 12, total_recording_seconds: 12, recordings: 1 } }));
    backend.resetStatistics.mockResolvedValue(makeSnapshot());
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить' }));
    expect(backend.resetStatistics).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Да, сбросить' }));
    await screen.findByText('Статистика сброшена.');
    expect(backend.resetStatistics).toHaveBeenCalledOnce();
  });

  it('shows local validation and backend errors without hiding either', async () => {
    await mount(makeSnapshot({ last_error: 'Микрофон отключён' }));
    fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: 'Super+' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(backend.saveSettings).not.toHaveBeenCalled();
    expect(screen.getByText('Проверьте настройки')).toBeTruthy();
    expect(screen.getByText('Микрофон отключён')).toBeTruthy();
    backend.toggleRecording.mockRejectedValue(new Error('Нет разрешения на микрофон'));
    fireEvent.click(screen.getByRole('button', { name: 'Начать запись' }));
    await screen.findByText(/Не удалось начать или остановить запись: Нет разрешения на микрофон/);
  });

  it('keeps an unavailable saved microphone selectable and exposes device-list failures', async () => {
    backend.listInputDevices.mockRejectedValue('Нет доступа к устройствам');
    await mount(makeSnapshot({ settings: { ...makeSnapshot().settings, input_device: 'missing-mic' } }));
    expect(screen.getByLabelText('Микрофон')).toHaveProperty('value', 'missing-mic');
    expect(screen.getByRole('option', { name: 'Сохранённый микрофон (нет в списке)' })).toBeTruthy();
    await screen.findByText(/Не удалось получить микрофоны: Нет доступа к устройствам/);
  });

  it('offers applying a missing GNOME shortcut even when settings have not changed', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    const command = '"/opt/STT Simple/stt-simple" --toggle';
    const ttsCommand = '"/opt/STT Simple/stt-simple" --toggle-tts';
    await mount(makeSnapshot({ hotkey_available: false, hotkey_mode: 'system', hotkey_command: command,
      hotkey_message: 'Системное сочетание отсутствует.', tts_hotkey_available: false,
      tts_hotkey_command: ttsCommand, tts_hotkey_message: 'Назначьте озвучивание вручную. TTS на Linux не проверен.' }));
    expect(screen.getByText(command)).toBeTruthy();
    expect(screen.getByText(ttsCommand)).toBeTruthy();
    expect(screen.getAllByText(/TTS на Linux не проверен/)).toHaveLength(2);
    expect(screen.getByText(/автоматическая регистрация GNOME применяется только к диктовке/i)).toBeTruthy();
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
    expect(screen.getByText(/· настроено в GNOME/)).toBeTruthy();
  });

  it('does not show Wayland instructions on Linux with native shortcut registration', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    await mount(makeSnapshot({ hotkey_mode: 'native', hotkey_available: true }));
    expect(screen.queryByRole('heading', { name: 'Системное сочетание клавиш' })).toBeNull();
    expect(screen.queryByText(/настроено в GNOME/)).toBeNull();
    expect(screen.getAllByText(/зарегистрировано/)).toHaveLength(2);
  });

  it('keeps the saved GNOME status and settings when applying another shortcut fails', async () => {
      const saved = makeSnapshot({ hotkey_mode: 'system', hotkey_available: true });
      await mount(saved);
      backend.saveSettings.mockRejectedValue('Сочетание уже назначено другому приложению.');
      fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: 'Super+E' } });
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
      await screen.findByText(/Не удалось сохранить настройки: Сочетание уже назначено/);
      expect(screen.getByText(/· настроено в GNOME/)).toBeTruthy();
      expect(screen.getByText('Super+R', { selector: '.shortcut-hint kbd' })).toBeTruthy();
      expect(screen.getByLabelText('Сочетание клавиш')).toHaveProperty('value', 'Super+E');
    });

    it('disables system shortcut application while recording', async () => {
      await mount(makeSnapshot({ phase: 'recording', hotkey_mode: 'system', hotkey_available: false }));
      expect(screen.getByRole('button', { name: 'Сохранить настройки' }).matches(':disabled')).toBe(true);
    });

    it('distinguishes a native registration failure from the Wayland system mode', async () => {
    await mount(makeSnapshot({ hotkey_mode: 'native', hotkey_available: false, hotkey_message: 'Сочетание занято.' }));
    expect(screen.getByText(/не удалось зарегистрировать/)).toBeTruthy();
    expect(screen.getByText('Сочетание занято.')).toBeTruthy();
    expect(screen.queryByText(/Команда для этой сборки/)).toBeNull();
  });

  it('allows choosing the current recommended transcription model', async () => {
    const settings = { ...makeSnapshot().settings, model: 'gpt-transcribe' };
    await mount();
    backend.saveSettings.mockResolvedValue(makeSnapshot({ settings }));
    fireEvent.change(screen.getByLabelText('Модель'), { target: { value: 'gpt-transcribe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await screen.findByText('Настройки сохранены.');
    expect(backend.saveSettings).toHaveBeenCalledWith(settings);
  });

  it('allows a custom model ID not present in the suggestions', async () => {
    const settings = { ...makeSnapshot().settings, model: 'gpt-transcribe-future-snapshot' };
    await mount();
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
    await mount();
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
    await mount(initial);
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
    await mount();
    fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: 'Super+Control+A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(await screen.findByText(/не должны совпадать/)).toBeTruthy();
    expect(backend.saveSettings).not.toHaveBeenCalled();
  });

  it('preserves an existing custom model while changing another setting', async () => {
    const saved = { ...makeSnapshot().settings, model: 'custom-transcription-model' };
    await mount(makeSnapshot({ settings: saved }));
    expect(screen.getByLabelText('ID модели OpenAI')).toHaveProperty('value', saved.model);
    const settings = { ...saved, shortcut: 'Control+Alt+R' };
    backend.saveSettings.mockResolvedValue(makeSnapshot({ settings }));
    fireEvent.change(screen.getByLabelText('Сочетание клавиш'), { target: { value: settings.shortcut } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await screen.findByText('Настройки сохранены.');
    expect(backend.saveSettings).toHaveBeenCalledWith(settings);
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
