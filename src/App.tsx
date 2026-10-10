import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { backend, inTauri } from './backend';
import type { Settings } from './types';
import { useAppState } from './useAppState';
import { PolishSettingsFields } from './PolishSettingsFields';
import { TranscriptResult } from './TranscriptResult';
import {
  DEFAULT_MODEL, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, MODELS, TTS_MODELS, TTS_VOICES,
  canRunAction, formatDuration, formatShortcutHint, isBusy, normalizeSettings, settingsEqual, statusText,
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
    shortcut: '',
    model: DEFAULT_MODEL,
    tts_shortcut: '',
    polish_shortcut: /Linux|X11/i.test(navigator.userAgent) ? 'Super+Backslash' : 'Control+Super+Backslash',
    tts_model: DEFAULT_TTS_MODEL,
    tts_voice: DEFAULT_TTS_VOICE,
    input_device: null,
    auto_paste: false,
    paste_shortcut: 'ctrl_v',
    polish: { profile_id: null, model: 'gpt-6-luna', effort: null, custom_profiles: [], favorite_profile_ids: [] },
  });
  const [manualModel, setManualModel] = useState(false);
  const [manualTtsModel, setManualTtsModel] = useState(false);
  const [manualTtsVoice, setManualTtsVoice] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [keyGeneration, setKeyGeneration] = useState(0);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [page, setPage] = useState<'home' | 'settings'>('home');
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const navigationButton = useRef<HTMLButtonElement>(null);

  function navigate(next: 'home' | 'settings') {
    setPage(next);
    window.scrollTo?.({ top: 0 });
  }

  useEffect(() => {
    if (page === 'settings') pageHeading.current?.focus();
    else navigationButton.current?.focus();
  }, [page]);

  const dirtyDraft = useRef(false);
  const profileEdited = useRef(false);
  const previousSettings = useRef<Settings | null>(null);
  const savedSettings = snapshot?.settings;
  useEffect(() => {
    if (!savedSettings) return;
    const previous = previousSettings.current;
    previousSettings.current = savedSettings;
    if (previous && settingsEqual(previous, savedSettings)) return;
    if (dirtyDraft.current) {
      if (previous && previous.polish.profile_id !== savedSettings.polish.profile_id && !profileEdited.current) {
        setDraft((current) => ({ ...current, polish: { ...current.polish, profile_id: savedSettings.polish.profile_id } }));
      }
      return;
    }
    profileEdited.current = false;
    setDraft(savedSettings);
    setManualModel(!MODELS.some((model) => model.value === savedSettings.model));
    setManualTtsModel(!TTS_MODELS.some((model) => model.value === savedSettings.tts_model));
    setManualTtsVoice(!TTS_VOICES.some((voice) => voice.value === savedSettings.tts_voice));
    setSettingsError(null);
  }, [savedSettings]);

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
  const synthesizing = snapshot?.phase === 'synthesizing';
  const playing = snapshot?.phase === 'playing';
  const speaking = synthesizing || playing;
  const normalized = normalizeSettings(draft);
  const settingsChanged = snapshot ? !settingsEqual(normalized, snapshot.settings) : false;
  const missingDevice = draft.input_device !== null
    && !devices.some((device) => device.id === draft.input_device);
  const linux = /Linux|X11/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
  const mac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  const systemHotkey = snapshot?.hotkey_mode === 'system';
  const customModel = manualModel || !MODELS.some((model) => model.value === draft.model);
  const customTtsModel = manualTtsModel || !TTS_MODELS.some((model) => model.value === draft.tts_model);
  const customTtsVoice = manualTtsVoice || !TTS_VOICES.some((voice) => voice.value === draft.tts_voice);
  const toggleDisabled = !connected || pending !== null || !canRunAction('toggle_recording', snapshot);
  const speechDisabled = !connected || pending !== null || !canRunAction('toggle_speech', snapshot);
  const activeMicrophone = snapshot?.settings.input_device
    ? devices.find((device) => device.id === snapshot.settings.input_device)?.name ?? 'Сохранённый микрофон (недоступен)'
    : 'Системный по умолчанию';
  const activeProfile = [...(snapshot?.builtin_polish_profiles ?? []), ...(snapshot?.settings.polish.custom_profiles ?? [])]
    .find((profile) => profile.id === snapshot?.settings.polish.profile_id);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = normalizeSettings(draft);
    const error = validateSettings(next, snapshot?.builtin_polish_profiles.map((profile) => profile.id));
    setSettingsError(error);
    if (error) return;
    if (await runAction('save_settings', async () => {
      const saved = await backend.saveSettings(next);
      dirtyDraft.current = false;
      profileEdited.current = false;
      setDraft(saved.settings);
      return saved;
    })) {
      setFeedback('Настройки сохранены.');
    }
  }

  async function saveApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validateApiKey(apiKey);
    setKeyError(error);
    if (error) return;
    if (await runAction('set_api_key', async () => {
      setKeyGeneration((generation) => generation + 1);
      const saved = await backend.setApiKey(apiKey.trim());
      setApiKey('');
      return saved;
    })) {
      setFeedback('API-ключ сохранён. Поле ввода очищено.');
    }
  }

  function updateDraft<K extends keyof Settings>(key: K, value: Settings[K]) {
    if (key === 'polish' && (value as Settings['polish']).profile_id !== draft.polish.profile_id) {
      profileEdited.current = true;
    }
    const next = { ...draft, [key]: value };
    dirtyDraft.current = !snapshot || !settingsEqual(normalizeSettings(next), snapshot.settings);
    setDraft(next);
    setSettingsError(null);
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark"><MicrophoneIcon /></div>
          <div><h1>STT Simple</h1><p>Говорите. Получайте текст.</p></div>
        </div>
        <div className="header-actions">
          <button ref={navigationButton} className="button button-secondary button-small" aria-controls="settings-page"
            aria-expanded={page === 'settings'} onClick={() => navigate(page === 'home' ? 'settings' : 'home')}>
            {page === 'home' ? 'Настройки' : 'К диктовке'}
            {settingsChanged && <span className="unsaved-dot" aria-label="Есть несохранённые изменения" />}
          </button>
          <button className="button button-quiet button-small" disabled={locked}
            onClick={() => void runAction('quit_app', backend.quitApp)}>
            {pending === 'quit_app' ? 'Закрытие…' : 'Выйти'}
          </button>
        </div>
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

      <div className="home-page" hidden={page !== 'home'}>
      <section className={`card recording-card${recording ? ' is-recording' : ''}`} aria-labelledby="recording-heading">
        <div className="section-heading">
          <h2 id="recording-heading">Диктовка</h2>
          <span className={`status-badge${recording ? ' status-recording' : ''}`} role="status">
            <span className="status-dot" aria-hidden="true" />
            {snapshot ? statusText(snapshot.phase) : syncError ? 'Нет подключения' : 'Подключение…'}
          </span>
        </div>
        {snapshot && <p className="recording-summary">
          <span>Микрофон: <strong>{activeMicrophone}</strong></span>
          <span>Обработка: <strong>{activeProfile?.name || 'Выключена'}</strong></span>
        </p>}
        <div className="recording-content">
          <div className="recording-symbol" aria-hidden="true"><MicrophoneIcon /></div>
          <div className="timer" role="timer" aria-label="Длительность текущей записи" aria-live="off">
            {formatDuration(snapshot?.recording_seconds ?? 0)}
          </div>
          <p className="recording-hint">
            {recording ? 'Нажмите «Остановить», чтобы распознать запись.'
              : snapshot?.phase === 'polishing' ? 'Обрабатываем распознанный текст в OpenAI.'
              : processing ? 'Распознаём вашу запись. Это может занять некоторое время.'
              : speaking ? 'Начало записи остановит текущее озвучивание.'
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
              Сочетание: <kbd>{formatShortcutHint(snapshot.settings.shortcut, mac)}</kbd>
              <span>{systemHotkey
                ? snapshot.hotkey_available ? ' · настроено в GNOME' : ' · не настроено в GNOME'
                : snapshot.hotkey_available ? ' · зарегистрировано' : ' · не удалось зарегистрировать'}</span>
            </p>
          )}
        </div>
      </section>

      <TranscriptResult snapshot={snapshot} connected={connected} pending={pending} runAction={runAction}
        autoPaste={snapshot?.settings.auto_paste ?? false} mac={mac} linux={linux} />

      <section className={`card speech-card${speaking ? ' is-speaking' : ''}`} aria-labelledby="speech-heading">
        <div className="section-heading">
          <h2 id="speech-heading">Озвучивание буфера</h2>
          <span className={`status-badge${speaking ? ' status-speaking' : ''}`} role="status">
            <span className="status-dot" aria-hidden="true" />
            {synthesizing ? 'Создаём речь' : playing ? 'Воспроизводим речь' : 'Готово к озвучиванию'}
          </span>
        </div>
        <p className="section-description">Текст из буфера обмена отправляется в OpenAI. Голос сгенерирован ИИ и не является голосом человека. Использование API оплачивается вашим аккаунтом OpenAI; приложение не рассчитывает стоимость.</p>
        <div className="speech-actions">
          <button className={`button button-primary${speaking ? ' button-stop' : ''}`}
            disabled={speechDisabled}
            onClick={() => void runAction('toggle_speech', backend.toggleSpeech)}>
            <span className={speaking ? 'stop-icon' : 'speak-icon'} aria-hidden="true" />
            {pending === 'toggle_speech' ? 'Подождите…' : speaking ? 'Остановить' : 'Озвучить буфер'}
          </button>
        </div>
        {snapshot && (
          <p className="shortcut-hint">
            Сочетание: <kbd>{formatShortcutHint(snapshot.settings.tts_shortcut, mac)}</kbd>
            <span>{systemHotkey
              ? ' · на Wayland назначается вручную'
              : snapshot.tts_hotkey_available ? ' · зарегистрировано' : ' · не удалось зарегистрировать'}</span>
          </p>
        )}
        {(recording || processing) && <p className="help lock-hint">Озвучивание доступно после завершения записи и распознавания.</p>}
      </section>

      </div>

      <div id="settings-page" hidden={page !== 'settings'}>
        <div className="settings-page-heading">
          <h2 ref={pageHeading} tabIndex={-1}>Настройки приложения</h2>
          <p className="section-description">Настройте диктовку и озвучивание. Изменения применяются после сохранения.</p>
          {settingsChanged && <p className="draft-notice" role="status">Есть несохранённые изменения. Черновик сохраняется при переходе к диктовке.</p>}
        </div>
        <nav className="settings-navigation" aria-label="Разделы настроек">
          <a href="#dictation-settings">Диктовка</a>
          <a href="#tts-settings-heading">Озвучивание</a>
          <a href="#polish-settings">Обработка текста</a>
          <a href="#key-heading">Подключение</a>
        </nav>
      <div className="settings-grid">
        <section className="card" aria-labelledby="settings-heading">
          <div className="section-heading"><h2 id="settings-heading">Диктовка и озвучивание</h2></div>
          <form onSubmit={(event) => void saveSettings(event)}>
            <fieldset disabled={locked}>
              <legend className="visually-hidden">Микрофон, модели, голос и сочетания клавиш</legend>
              <section id="dictation-settings" aria-labelledby="dictation-settings-heading">
                <h3 id="dictation-settings-heading" className="settings-group-heading">Диктовка</h3>
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
                <p className="help" id="shortcut-help">Например, <kbd>{formatShortcutHint('Super+R', mac)}</kbd> или
                  <kbd>{formatShortcutHint('Control+Super+R', mac)}</kbd>. {systemHotkey
                    ? 'После сохранения приложение создаст или обновит сочетания диктовки и переключения обработки в GNOME. Чужие сочетания не перезаписываются.'
                    : 'После сохранения приложение зарегистрирует сочетание в системе.'}</p>
              </div>
              <div className="settings-subsection" aria-labelledby="paste-settings-heading">
                <h3 id="paste-settings-heading">Вставка результата</h3>
              {(mac || linux) && (
                <div className="field checkbox-field">
                  <label className="checkbox-label" htmlFor="auto-paste">
                    <input id="auto-paste" type="checkbox" checked={draft.auto_paste} aria-describedby="auto-paste-help"
                      onChange={(event) => updateDraft('auto_paste', event.target.checked)} />
                    <span>Автоматически вставлять результат</span>
                  </label>
                  <p className="help" id="auto-paste-help">По умолчанию выключено. Работает только для записи,
                    начатой глобальным hotkey и остановленной hotkey или автоматически по лимиту.
                    Кнопка и меню трея только копируют текст. Не переключайте фокус: вставка идёт
                    в активное поле на момент завершения распознавания. {mac
                      ? 'macOS запросит разрешение «Универсальный доступ» для Cmd+V; при отказе текст всё равно останется в буфере обмена.'
                      : <>{systemHotkey
                        ? 'Wayland: нужен ydotool; для современного ydotool 1.x самостоятельно настройте демон, доступ к uinput и сокету по инструкции вашего дистрибутива. YDOTOOL_SOCKET наследуется из окружения приложения. Пакет Ubuntu 22.04 может быть устаревшим.'
                        : 'X11: нужен xdotool в PATH.'} Приложение не запускает sudo и не настраивает службы.
                        При ошибке или тайм-ауте 5 секунд текст остаётся в буфере обмена.</>}</p>
                </div>
              )}
              {linux && (
                <div className="field">
                  <label htmlFor="paste-shortcut">Сочетание для вставки</label>
                  <select id="paste-shortcut" value={draft.paste_shortcut} disabled={!draft.auto_paste}
                    aria-describedby="paste-shortcut-help"
                    onChange={(event) => updateDraft('paste_shortcut', event.target.value as Settings['paste_shortcut'])}>
                    <option value="ctrl_v">Ctrl+V</option>
                    <option value="ctrl_shift_v">Ctrl+Shift+V</option>
                  </select>
                  <p className="help" id="paste-shortcut-help">По умолчанию Ctrl+V. Выберите сочетание, которое
                    работает вручную в целевом поле. Ctrl+Shift+V может подойти для вставки обычного текста
                    в чат Zed или в терминал — проверьте конкретное поле. Выбор один для всех приложений:
                    приложение не определяет цель и не пробует второе сочетание после первого.</p>
                </div>
              )}
              </div>
              </section>
              <section className="settings-subsection" aria-labelledby="tts-settings-heading">
                <h3 id="tts-settings-heading">Озвучивание</h3>
                <div className="field">
                  <label htmlFor="tts-model">TTS-модель</label>
                  <select id="tts-model" value={customTtsModel ? '__custom__' : draft.tts_model}
                    aria-describedby="tts-model-help" onChange={(event) => {
                      const custom = event.target.value === '__custom__';
                      setManualTtsModel(custom);
                      if (!custom) updateDraft('tts_model', event.target.value);
                    }}>
                    {TTS_MODELS.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                    <option value="__custom__">Свой ID TTS-модели…</option>
                  </select>
                  {customTtsModel && <>
                    <label htmlFor="tts-model-id">ID TTS-модели OpenAI</label>
                    <input id="tts-model-id" value={draft.tts_model} maxLength={128} spellCheck={false}
                      autoComplete="off" autoCapitalize="none" placeholder="gpt-4o-mini-tts"
                      aria-describedby="tts-model-help" onChange={(event) => updateDraft('tts_model', event.target.value)} />
                  </>}
                  <p className="help" id="tts-model-help">GPT-4o mini TTS — известная модель Speech API.
                    Можно указать другой ID; список служит подсказкой, а доступность определяет OpenAI.</p>
                </div>
                <div className="field">
                  <label htmlFor="tts-voice">Голос</label>
                  <select id="tts-voice" value={customTtsVoice ? '__custom__' : draft.tts_voice}
                    aria-describedby="tts-voice-help" onChange={(event) => {
                      const custom = event.target.value === '__custom__';
                      setManualTtsVoice(custom);
                      if (!custom) updateDraft('tts_voice', event.target.value);
                    }}>
                    {TTS_VOICES.map((voice) => <option key={voice.value} value={voice.value}>{voice.label}</option>)}
                    <option value="__custom__">Свой ID голоса…</option>
                  </select>
                  {customTtsVoice && <>
                    <label htmlFor="tts-voice-id">ID голоса OpenAI</label>
                    <input id="tts-voice-id" value={draft.tts_voice} maxLength={128} spellCheck={false}
                      autoComplete="off" autoCapitalize="none" placeholder="marin"
                      aria-describedby="tts-voice-help" onChange={(event) => updateDraft('tts_voice', event.target.value)} />
                  </>}
                  <p className="help" id="tts-voice-help">Marin и Cedar рекомендованы OpenAI для лучшего качества.
                    Доступность голоса зависит от модели; можно указать собственный ID.</p>
                </div>
                <div className="field">
                  <label htmlFor="tts-shortcut">Сочетание клавиш озвучивания</label>
                  <input id="tts-shortcut" value={draft.tts_shortcut} maxLength={128} spellCheck={false}
                    placeholder="Control+Super+A" autoComplete="off" aria-describedby="tts-shortcut-help"
                    aria-invalid={Boolean(settingsError)}
                    onChange={(event) => updateDraft('tts_shortcut', event.target.value)} />
                  <p className="help" id="tts-shortcut-help">Например, <kbd>{formatShortcutHint('Control+Super+A', mac)}</kbd>.
                    {systemHotkey
                      ? ' На Wayland назначьте показанную ниже команду --toggle-tts вручную; автоматическая регистрация GNOME применяется к диктовке и переключению обработки.'
                      : ' После сохранения приложение зарегистрирует сочетание в системе.'}</p>
                </div>
              </section>
              <div id="polish-settings" className="settings-subsection">
              <div className="field">
                <label htmlFor="polish-shortcut">Сочетание клавиш переключения обработки</label>
                <input id="polish-shortcut" value={draft.polish_shortcut} maxLength={128} spellCheck={false}
                  placeholder={linux ? 'Super+Backslash' : 'Control+Super+Backslash'} autoComplete="off" aria-describedby="polish-shortcut-help"
                  aria-invalid={Boolean(settingsError)}
                  onChange={(event) => updateDraft('polish_shortcut', event.target.value)} />
                <p className="help" id="polish-shortcut-help">Например, <kbd>{formatShortcutHint(linux ? 'Super+Backslash' : 'Control+Super+Backslash', mac).replace('Backslash', '\\').replace('Super', linux ? 'Win' : 'Super')}</kbd>.
                  Переключает «Выключено» и избранные профили в порядке списка.</p>
              </div>
              <PolishSettingsFields key={`${keyGeneration}:${snapshot?.has_api_key}:${connected}`}
                value={draft.polish} builtins={snapshot?.builtin_polish_profiles ?? []}
                hasApiKey={snapshot?.has_api_key ?? false}
                onChange={(value) => updateDraft('polish', value)} />
              </div>
              <button className="button button-secondary" type="submit" disabled={!settingsChanged && !systemHotkey}>
                {pending === 'save_settings' ? 'Сохранение…' : 'Сохранить настройки'}
              </button>
            </fieldset>
          </form>
          {settingsError && <ErrorNotice title="Проверьте настройки" message={settingsError} />}
          {deviceError && <ErrorNotice title="Микрофоны недоступны" message={deviceError} />}
          {busy && <p className="help lock-hint">Настройки доступны после завершения записи, обработки или озвучивания.</p>}
        </section>

        <section className="card" aria-labelledby="key-heading">
          <div className="section-heading">
            <h2 id="key-heading">Подключение</h2>
            <span className={`key-badge${snapshot?.has_api_key ? ' key-saved' : ''}`}>
              {snapshot ? snapshot.has_api_key ? 'Сохранён' : 'Не задан' : 'Проверка…'}
            </span>
          </div>
          <p className="section-description">Ключ OpenAI нужен для распознавания и озвучивания. Аудиозапись отправляется для распознавания; при озвучивании в OpenAI отправляется текст из буфера обмена.</p>
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
                    if (await runAction('delete_api_key', () => {
                                          setKeyGeneration((generation) => generation + 1);
                                          return backend.deleteApiKey();
                                        })) {
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

      {snapshot && (systemHotkey || !snapshot.hotkey_available || snapshot.hotkey_message
        || !snapshot.tts_hotkey_available || snapshot.tts_hotkey_message
        || !snapshot.polish_hotkey_available || snapshot.polish_hotkey_message) && (
        <aside className="card hotkey-card" aria-labelledby="hotkey-heading">
          <h2 id="hotkey-heading">Системное сочетание клавиш</h2>
          {snapshot.hotkey_message && <p className="hotkey-message"><strong>Диктовка:</strong> {snapshot.hotkey_message}</p>}
          {snapshot.tts_hotkey_message && <p className="hotkey-message"><strong>Озвучивание:</strong> {snapshot.tts_hotkey_message}</p>}
          {snapshot.polish_hotkey_message && <p className="hotkey-message"><strong>Переключение обработки:</strong> {snapshot.polish_hotkey_message}</p>}
          {systemHotkey && <>
            <p>На Ubuntu GNOME/Wayland нажмите «Сохранить настройки», чтобы применить выбранные
              сочетания диктовки и переключения обработки к системе. Команда диктовки для этой сборки:</p>
            <code className="command">{snapshot.hotkey_command ?? 'stt-simple --toggle'}</code>
            <p className="help">Привязка проверяется при запуске и сохранении настроек. Если комбинация
              занята, выберите свободную или освободите её в «Настройки GNOME → Клавиатура →
              Пользовательские сочетания клавиш». Там же можно удалить привязку STT Simple.
              Она сохраняется после выхода и может запускать приложение. После перемещения бинарника
              сохраните настройки снова, чтобы обновить путь. В других Wayland-окружениях назначьте
              показанную команду вручную. Проверка не гарантирует отсутствие перехвата клавиш расширениями GNOME.</p>
            <div className="wayland-tts">
              <h3>Озвучивание на Wayland</h3>
              <p>Назначьте сочетание <kbd>{formatShortcutHint(snapshot.settings.tts_shortcut, mac)}</kbd> вручную на команду:</p>
              <code className="command">{snapshot.tts_hotkey_command ?? 'stt-simple --toggle-tts'}</code>
              <p className="help">Озвучивание назначается вручную; диктовка и переключение обработки настраиваются автоматически. TTS на Linux не проверен.</p>
            </div>
            <div className="wayland-tts">
              <h3>Переключение обработки на Wayland</h3>
              <p>Сочетание <kbd>{formatShortcutHint(snapshot.settings.polish_shortcut, mac).replace('Backslash', '\\').replace('Super', linux ? 'Win' : 'Super')}</kbd>
                {snapshot.polish_hotkey_available ? ' · настроено в GNOME' : ' · не настроено в GNOME'}.
                Нажмите «Сохранить настройки», чтобы создать или обновить привязку.</p>
              <code className="command">{snapshot.polish_hotkey_command ?? 'stt-simple --cycle-polish'}</code>
            </div>
          </>}
          {linux && <p className="help">Для работы в фоне сверните окно. В Linux закрытие окна тоже сворачивает его,
            а не скрывает в системный трей. Чтобы завершить приложение, нажмите «Выйти».</p>}
          {!systemHotkey && !snapshot.hotkey_available && <p className="help">Используйте кнопку записи.
            Проверьте, не занято ли сочетание другим приложением, и сохраните другое в настройках.</p>}
          {!systemHotkey && !snapshot.tts_hotkey_available && <p className="help">Используйте кнопку «Озвучить буфер».
            Проверьте, не занято ли сочетание озвучивания, и сохраните другое в настройках.</p>}
        </aside>
      )}

      </div>

      <section className={`card statistics-card${page === 'home' ? ' statistics-compact' : ''}`} aria-labelledby="statistics-heading">
        <div className="section-heading">
          <h2 id="statistics-heading">Статистика</h2>
          <button className="text-button" hidden={page !== 'settings'} disabled={locked || !snapshot
            || (snapshot.statistics.recordings === 0 && snapshot.statistics.total_recording_seconds === 0
              && snapshot.statistics.last_recording_seconds === 0)}
            onClick={() => setConfirmReset(true)}>
            {pending === 'reset_statistics' ? 'Сброс…' : 'Сбросить'}
          </button>
        </div>
        {confirmReset && page === 'settings' && (
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
      <footer className="app-footer">Диктовка и озвучивание — без лишних шагов.</footer>
    </main>
  );
}
