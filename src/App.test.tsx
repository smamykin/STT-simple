// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useAppState } from './useAppState';
import { deferred, makeSnapshot } from './testFixtures';
import type { Snapshot } from './types';
import { MODELS } from './utils';

const backend = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  listInputDevices: vi.fn(),
  saveSettings: vi.fn(),
  setApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  toggleRecording: vi.fn(),
  cancelRecording: vi.fn(),
  resetStatistics: vi.fn(),
  copyLastTranscript: vi.fn(),
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
  });

  it('requires an API key before enabling start', async () => {
    await mount(makeSnapshot({ has_api_key: false }));
    expect(screen.getByRole('button', { name: 'Начать запись' })).toHaveProperty('disabled', true);
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

  it.each(['recording', 'transcribing', 'polishing'] as const)('locks settings, key and statistics during %s', async (phase) => {
    await mount(makeSnapshot({
      phase,
      statistics: { last_recording_seconds: 5, total_recording_seconds: 5, recordings: 1 },
    }));
    for (const label of ['Микрофон', 'Модель', 'Сочетание клавиш', 'Новый ключ']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).matches(':disabled')).toBe(true);
    }
    expect(screen.getByRole('button', { name: 'Сбросить' })).toHaveProperty('disabled', true);
    expect(Boolean(screen.queryByRole('button', { name: 'Отменить запись' }))).toBe(phase === 'recording');
    if (phase !== 'recording') {
      expect(screen.getByRole('button', { name: 'Обработка…' })).toHaveProperty('disabled', true);
    }
  });

  it.each(['recording', 'transcribing', 'polishing'] as const)('disables Copy during %s even with a transcript and re-enables it when idle', async (phase) => {
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
    const settings = {
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
    await mount();
    const autoPaste = screen.getByLabelText('Автоматически вставлять результат');
    expect(autoPaste).toHaveProperty('checked', false);
    expect(screen.getByText(/разрешение «Универсальный доступ»/)).toBeTruthy();
    const saved = makeSnapshot({ settings: { ...makeSnapshot().settings, auto_paste: true } });
    backend.saveSettings.mockResolvedValue(saved);
    backend.getSnapshot.mockResolvedValue(saved);
    fireEvent.click(autoPaste);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledWith(saved.settings));
    expect(screen.getByText(/автоматически вставляется в активное поле/)).toBeTruthy();
  });

  it('does not offer macOS auto-paste on Linux', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    await mount();
    expect(screen.queryByLabelText('Автоматически вставлять результат')).toBeNull();
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
    await mount(makeSnapshot({ hotkey_available: false, hotkey_mode: 'system', hotkey_command: command,
      hotkey_message: 'Системное сочетание отсутствует.' }));
    expect(screen.getByText(command)).toBeTruthy();
    expect(screen.getByText(/не настроено в GNOME/)).toBeTruthy();
    expect(screen.queryByText(/недоступно, используйте кнопку/)).toBeNull();
    expect(screen.queryByText(/не удалось зарегистрировать/)).toBeNull();
    expect(screen.getByText(/Чужие сочетания не перезаписываются/)).toBeTruthy();
    expect(screen.getByText('Системное сочетание отсутствует.')).toBeTruthy();
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
    expect(screen.getByText(/зарегистрировано/)).toBeTruthy();
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
