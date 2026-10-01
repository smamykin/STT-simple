import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { backend, inTauri } from './backend';
import type { Settings } from './types';
import { useAppState } from './useAppState';
import {
  DEFAULT_MODEL, MODELS, canRunAction, formatDuration, isBusy, normalizeSettings, settingsEqual, statusText,
  validateApiKey, validateSettings,
} from './utils';

function MicrophoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8" />
    </svg>
  );
}

function ErrorNotice({ title, message }: { title: string; message: string }) {
  return (
    <div className="notice notice-error" role="alert">
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  );
}

function DesktopRequired() {
  return (
    <main className="desktop-required">
      <div className="brand-mark"><MicrophoneIcon /></div>
      <p className="eyebrow">STT SIMPLE</p>
      <h1>Диктовка в настольном приложении</h1>
      <p>Этот интерфейс работает только внутри Tauri. В браузере нет доступа к микрофону,
        системным сочетаниям клавиш и хранилищу API-ключей приложения.</p>
      <p>Для разработки запустите <code>npm run tauri dev</code> после установки зависимостей
        и настройки Rust-бэкенда. Для обычной работы откройте установленное приложение STT Simple.</p>
    </main>
  );
}

export default function App() {
  const {
    snapshot, connected, syncError, actionError, pending, devices, devicesLoading,
    deviceError, refreshDevices, runAction, retry,
  } = useAppState();
  const [draft, setDraft] = useState<Settings>({
    shortcut: '', model: DEFAULT_MODEL, input_device: null, auto_paste: false,
  });
  const [manualModel, setManualModel] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const savedShortcut = snapshot?.settings.shortcut;
  const savedModel = snapshot?.settings.model;
  const savedDevice = snapshot?.settings.input_device;
  const savedAutoPaste = snapshot?.settings.auto_paste;
  useEffect(() => {
    if (savedShortcut === undefined || savedModel === undefined || savedDevice === undefined
      || savedAutoPaste === undefined) return;
    setDraft({
      shortcut: savedShortcut, model: savedModel, input_device: savedDevice, auto_paste: savedAutoPaste,
    });
    setManualModel(!MODELS.some((model) => model.value === savedModel));
    setSettingsError(null);
  }, [savedShortcut, savedModel, savedDevice, savedAutoPaste]);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);

  if (!inTauri) return <DesktopRequired />;

  const busy = snapshot ? isBusy(snapshot.phase) : false;
  const locked = !snapshot || !connected || busy || pending !== null;
  const recording = snapshot?.phase === 'recording';
  const processing = snapshot?.phase === 'transcribing' || snapshot?.phase === 'polishing';
  const normalized = normalizeSettings(draft);
  const settingsChanged = snapshot ? !settingsEqual(normalized, snapshot.settings) : false;
  const missingDevice = draft.input_device !== null
    && !devices.some((device) => device.id === draft.input_device);
  const linux = /Linux|X11/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
  const mac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  const systemHotkey = snapshot?.hotkey_mode === 'system';
  const customModel = manualModel || !MODELS.some((model) => model.value === draft.model);
  const toggleDisabled = !snapshot || !connected || pending !== null || processing
    || (!recording && !snapshot.has_api_key);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = normalizeSettings(draft);
    const error = validateSettings(next);
    setSettingsError(error);
    if (error) return;
    if (await runAction('save_settings', () => backend.saveSettings(next))) {
      setFeedback('Настройки сохранены.');
    }
  }

  async function saveApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validateApiKey(apiKey);
    setKeyError(error);
    if (error) return;
    if (await runAction('set_api_key', async () => {
      const saved = await backend.setApiKey(apiKey.trim());
      setApiKey('');
      return saved;
    })) {
      setFeedback('API-ключ сохранён. Поле ввода очищено.');
    }
  }

  function updateDraft<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSettingsError(null);
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark"><MicrophoneIcon /></div>
          <div><h1>STT Simple</h1><p>Говорите. Получайте текст.</p></div>
        </div>
        <button className="button button-quiet" disabled={locked}
          onClick={() => void runAction('quit_app', backend.quitApp)}>
          {pending === 'quit_app' ? 'Закрытие…' : 'Выйти'}
        </button>
      </header>

      <div className="notifications">
        {syncError && (
          <div>
            <ErrorNotice title="Нет связи с приложением" message={syncError} />
            <button className="button button-secondary retry-button" disabled={pending !== null}
              onClick={retry}>Повторить подключение</button>
          </div>
        )}
        {actionError && <ErrorNotice title="Действие не выполнено" message={actionError} />}
        {snapshot?.last_error && <ErrorNotice title="Ошибка приложения" message={snapshot.last_error} />}
        <div className="feedback" role="status" aria-live="polite">{feedback}</div>
      </div>

      <section className={`card recording-card${recording ? ' is-recording' : ''}`} aria-labelledby="recording-heading">
        <div className="section-heading">
          <h2 id="recording-heading">Диктовка</h2>
          <span className={`status-badge${recording ? ' status-recording' : ''}`} role="status">
            <span className="status-dot" aria-hidden="true" />
            {snapshot ? statusText(snapshot.phase) : syncError ? 'Нет подключения' : 'Подключение…'}
          </span>
        </div>
        <div className="recording-content">
          <div className="recording-symbol" aria-hidden="true"><MicrophoneIcon /></div>
          <div className="timer" role="timer" aria-label="Длительность текущей записи" aria-live="off">
            {formatDuration(snapshot?.recording_seconds ?? 0)}
          </div>
          <p className="recording-hint">
            {recording ? 'Нажмите «Остановить», чтобы распознать запись.'
              : processing ? 'Распознаём вашу запись. Это может занять некоторое время.'
              : snapshot && !snapshot.has_api_key ? 'Сохраните API-ключ OpenAI, чтобы начать.'
              : 'Одна кнопка — от голоса к тексту.'}
          </p>
          <div className="recording-actions">
            <button className={`button button-primary${recording ? ' button-stop' : ''}`}
              disabled={toggleDisabled}
              onClick={() => void runAction('toggle_recording', backend.toggleRecording)}>
              <span className={recording ? 'stop-icon' : 'record-icon'} aria-hidden="true" />
              {pending === 'toggle_recording' ? 'Подождите…' : recording ? 'Остановить' : processing ? 'Обработка…' : 'Начать запись'}
            </button>
            {recording && (
              <button className="button button-secondary" disabled={pending !== null || !connected}
                onClick={() => void runAction('cancel_recording', backend.cancelRecording)}>
                {pending === 'cancel_recording' ? 'Отмена…' : 'Отменить запись'}
              </button>
            )}
          </div>
          {snapshot && (
            <p className="shortcut-hint">
              Сочетание: <kbd>{snapshot.settings.shortcut}</kbd>
              <span>{systemHotkey
                ? snapshot.hotkey_available ? ' · настроено в GNOME' : ' · не настроено в GNOME'
                : snapshot.hotkey_available ? ' · зарегистрировано' : ' · не удалось зарегистрировать'}</span>
            </p>
          )}
        </div>
      </section>

      <section className="card transcript-card" aria-labelledby="transcript-heading">
        <div className="section-heading">
          <h2 id="transcript-heading">Последний результат</h2>
          <button className="button button-secondary button-small"
            disabled={!connected || !canRunAction('copy_last_transcript', snapshot) || pending !== null}
            onClick={async () => {
              if (await runAction('copy_last_transcript', backend.copyLastTranscript)) {
                setFeedback('Текст скопирован в буфер обмена.');
              }
            }}>
            {pending === 'copy_last_transcript' ? 'Копирование…' : 'Скопировать'}
          </button>
        </div>
        <label className="visually-hidden" htmlFor="transcript">Текст последней диктовки</label>
        <textarea id="transcript" className="transcript" readOnly rows={7}
          value={snapshot?.last_transcript ?? ''} placeholder="Здесь появится распознанный текст."
          aria-describedby="transcript-help" />
        <p className="help" id="transcript-help">{mac && snapshot?.settings.auto_paste
          ? 'При диктовке через hotkey текст автоматически вставляется в активное поле и остаётся в буфере обмена.'
          : 'Текст копируется в буфер обмена — вставьте его сочетанием Cmd+V или Ctrl+V.'}</p>
      </section>

      <div className="settings-grid">
        <section className="card" aria-labelledby="settings-heading">
          <div className="section-heading"><h2 id="settings-heading">Настройки</h2><span className="section-meta">Распознавание</span></div>
          <form onSubmit={(event) => void saveSettings(event)}>
            <fieldset disabled={locked}>
              <legend className="visually-hidden">Микрофон, модель и сочетание клавиш</legend>
              <div className="field">
                <div className="field-heading">
                  <label htmlFor="microphone">Микрофон</label>
                  <button type="button" className="text-button" disabled={devicesLoading}
                    onClick={() => void refreshDevices()}>
                    {devicesLoading ? 'Обновление…' : 'Обновить список'}
                  </button>
                </div>
                <select id="microphone" value={draft.input_device ?? ''}
                  onChange={(event) => updateDraft('input_device', event.target.value || null)}
                  aria-describedby="microphone-help">
                  <option value="">Системный по умолчанию</option>
                  {missingDevice && <option value={draft.input_device ?? ''}>Сохранённый микрофон (нет в списке)</option>}
                  {devices.map((device) => <option key={device.id} value={device.id}>
                    {device.name}{device.is_default ? ' — по умолчанию' : ''}
                  </option>)}
                </select>
                <p className="help" id="microphone-help">{missingDevice
                  ? 'Сохранённое устройство не найдено. Подключите его или выберите другой микрофон.'
                  : 'Используется выбранное устройство ввода звука.'}</p>
              </div>
              <div className="field">
                <label htmlFor="model">Модель</label>
                <select id="model" value={customModel ? '__custom__' : draft.model}
                  aria-describedby="model-help" onChange={(event) => {
                    const custom = event.target.value === '__custom__';
                    setManualModel(custom);
                    if (!custom) updateDraft('model', event.target.value);
                  }}>
                  {MODELS.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                  <option value="__custom__">Свой ID модели…</option>
                </select>
                {customModel && <>
                  <label htmlFor="model-id">ID модели OpenAI</label>
                  <input id="model-id" value={draft.model} maxLength={128} spellCheck={false}
                    autoComplete="off" autoCapitalize="none" placeholder="gpt-transcribe"
                    aria-describedby="model-help" onChange={(event) => updateDraft('model', event.target.value)} />
                </>}
                <p className="help" id="model-help">GPT Transcribe рекомендован OpenAI для файловой транскрипции.
                  Можно указать ID другой модели или snapshot. Модель должна поддерживать
                  <code>/v1/audio/transcriptions</code> и быть доступна вашему API-ключу.
                  Список — подсказки, не ограничение и не проверка доступа к моделям.</p>
              </div>
              <div className="field">
                <label htmlFor="shortcut">Сочетание клавиш</label>
                <input id="shortcut" value={draft.shortcut} maxLength={128} spellCheck={false}
                  placeholder="Super+R" autoComplete="off" aria-describedby="shortcut-help"
                  aria-invalid={Boolean(settingsError)}
                  onChange={(event) => updateDraft('shortcut', event.target.value)} />
                <p className="help" id="shortcut-help">Например, <kbd>Super+R</kbd> или
                  <kbd>Control+Super+R</kbd>. {mac && 'На macOS Super означает Command. '}{systemHotkey
                    ? 'После сохранения приложение создаст или обновит своё системное сочетание в GNOME. Чужие сочетания не перезаписываются.'
                    : 'После сохранения приложение зарегистрирует сочетание в системе.'}</p>
              </div>
              {mac && (
                <div className="field checkbox-field">
                  <label className="checkbox-label" htmlFor="auto-paste">
                    <input id="auto-paste" type="checkbox" checked={draft.auto_paste}
                      onChange={(event) => updateDraft('auto_paste', event.target.checked)} />
                    <span>Автоматически вставлять результат</span>
                  </label>
                  <p className="help">Работает для записи, начатой глобальным hotkey. macOS запросит
                    разрешение «Универсальный доступ»; при отказе текст всё равно останется в буфере обмена.</p>
                </div>
              )}
              <button className="button button-secondary" type="submit" disabled={!settingsChanged && !systemHotkey}>
                {pending === 'save_settings' ? 'Сохранение…' : 'Сохранить настройки'}
              </button>
            </fieldset>
          </form>
          {settingsError && <ErrorNotice title="Проверьте настройки" message={settingsError} />}
          {deviceError && <ErrorNotice title="Микрофоны недоступны" message={deviceError} />}
          {busy && <p className="help lock-hint">Настройки доступны после завершения записи и обработки.</p>}
        </section>

        <section className="card" aria-labelledby="key-heading">
          <div className="section-heading">
            <h2 id="key-heading">API-ключ</h2>
            <span className={`key-badge${snapshot?.has_api_key ? ' key-saved' : ''}`}>
              {snapshot ? snapshot.has_api_key ? 'Сохранён' : 'Не задан' : 'Проверка…'}
            </span>
          </div>
          <p className="section-description">Для распознавания нужен ключ OpenAI. Аудиозапись отправляется в OpenAI выбранной моделью.</p>
          <form onSubmit={(event) => void saveApiKey(event)} autoComplete="off">
            <fieldset disabled={locked}>
              <legend className="visually-hidden">Управление API-ключом OpenAI</legend>
              <div className="field">
                <label htmlFor="api-key">{snapshot?.has_api_key ? 'Новый ключ' : 'Ключ OpenAI'}</label>
                <input id="api-key" type="password" value={apiKey} placeholder="Введите API-ключ"
                  maxLength={1024} autoComplete="new-password" spellCheck={false} autoCapitalize="none"
                  aria-describedby="key-help" aria-invalid={Boolean(keyError)}
                  onChange={(event) => { setApiKey(event.target.value); setKeyError(null); }} />
                <p className="help" id="key-help">Передаётся бэкенду для сохранения в системном хранилище ключей.
                  Не сохраняется в браузере. После сохранения поле очищается.</p>
              </div>
              <div className="form-actions">
                <button className="button button-secondary" type="submit" disabled={!apiKey.trim()}>
                  {pending === 'set_api_key' ? 'Сохранение…' : 'Сохранить ключ'}
                </button>
                <button className="button button-danger-quiet" type="button" disabled={!snapshot?.has_api_key}
                  onClick={async () => {
                    if (await runAction('delete_api_key', backend.deleteApiKey)) {
                      setApiKey('');
                      setKeyError(null);
                      setFeedback('API-ключ удалён. Для новой записи потребуется сохранить ключ.');
                    }
                  }}>
                  {pending === 'delete_api_key' ? 'Удаление…' : 'Удалить ключ'}
                </button>
              </div>
            </fieldset>
          </form>
          {keyError && <ErrorNotice title="Проверьте API-ключ" message={keyError} />}
        </section>
      </div>

      {snapshot && (systemHotkey || !snapshot.hotkey_available || snapshot.hotkey_message) && (
        <aside className="card hotkey-card" aria-labelledby="hotkey-heading">
          <h2 id="hotkey-heading">Системное сочетание клавиш</h2>
          {snapshot?.hotkey_message && <p className="hotkey-message">{snapshot.hotkey_message}</p>}
          {systemHotkey && <>
            <p>На Ubuntu GNOME/Wayland нажмите «Сохранить настройки», чтобы применить выбранное
              сочетание к системе. Команда для этой сборки:</p>
            <code className="command">{snapshot.hotkey_command ?? 'stt-simple --toggle'}</code>
            <p className="help">Привязка проверяется при запуске и сохранении настроек. Если комбинация
              занята, выберите свободную или освободите её в «Настройки GNOME → Клавиатура →
              Пользовательские сочетания клавиш». Там же можно удалить привязку STT Simple.
              Она сохраняется после выхода и может запускать приложение. После перемещения бинарника
              сохраните настройки снова, чтобы обновить путь. В других Wayland-окружениях назначьте
              показанную команду вручную. Проверка не гарантирует отсутствие перехвата клавиш расширениями GNOME.</p>
          </>}
          {linux && <p className="help">Для работы в фоне сверните окно. В Linux закрытие окна тоже сворачивает его,
            а не скрывает в системный трей. Чтобы завершить приложение, нажмите «Выйти».</p>}
          {!systemHotkey && !snapshot.hotkey_available && <p className="help">Используйте кнопку записи.
            Проверьте, не занято ли сочетание другим приложением, и сохраните другое в настройках.</p>}
        </aside>
      )}

      <section className="card statistics-card" aria-labelledby="statistics-heading">
        <div className="section-heading">
          <h2 id="statistics-heading">Статистика</h2>
          <button className="text-button" disabled={locked || !snapshot
            || (snapshot.statistics.recordings === 0 && snapshot.statistics.total_recording_seconds === 0
              && snapshot.statistics.last_recording_seconds === 0)}
            onClick={() => setConfirmReset(true)}>
            {pending === 'reset_statistics' ? 'Сброс…' : 'Сбросить'}
          </button>
        </div>
        {confirmReset && (
          <div className="reset-confirmation" role="group" aria-labelledby="reset-question">
            <p id="reset-question">Сбросить длительность и количество записей?</p>
            <div className="form-actions">
              <button className="button button-danger-quiet" disabled={locked}
                onClick={async () => {
                  if (await runAction('reset_statistics', backend.resetStatistics)) {
                    setConfirmReset(false);
                    setFeedback('Статистика сброшена.');
                  }
                }}>Да, сбросить</button>
              <button className="button button-secondary" onClick={() => setConfirmReset(false)}>Не сбрасывать</button>
            </div>
          </div>
        )}
        <dl className="statistics">
          <div><dt>Последняя запись</dt><dd>{snapshot ? formatDuration(snapshot.statistics.last_recording_seconds) : '—'}</dd></div>
          <div><dt>Общая длительность</dt><dd>{snapshot ? formatDuration(snapshot.statistics.total_recording_seconds) : '—'}</dd></div>
          <div><dt>Количество записей</dt><dd>{snapshot ? new Intl.NumberFormat('ru-RU').format(snapshot.statistics.recordings) : '—'}</dd></div>
        </dl>
      </section>
      <footer className="app-footer">Только диктовка. Ваш текст — без лишних шагов.</footer>
    </main>
  );
}
