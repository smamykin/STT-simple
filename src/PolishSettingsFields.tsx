import { useEffect, useRef, useState } from 'react';
import { backend } from './backend';
import type { PolishProfile, PolishSettings } from './types';
import { MAX_CUSTOM_POLISH_PROFILES, POLISH_EFFORTS, POLISH_MODELS, POLISH_MODEL_EFFORTS, createPolishProfileId } from './utils';

export function PolishSettingsFields({ value, builtins, hasApiKey, onChange }: {
  value: PolishSettings;
  builtins: PolishProfile[];
  hasApiKey: boolean;
  onChange: (value: PolishSettings) => void;
}) {
  const [manualModel, setManualModel] = useState(false);
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const request = useRef<object | null>(null);
  useEffect(() => () => { request.current = null; }, []);

  async function refreshModels() {
    if (!hasApiKey || request.current) return;
    const token = {};
    request.current = token;
    setLoading(true);
    setCatalogError(null);
    try {
      const models = await backend.listOpenAiModels();
      if (request.current !== token) return;
      setCatalog([...new Set(models.map((model) => model.id))].filter((id) => !POLISH_MODELS.includes(id)));
    } catch (error) {
      if (request.current !== token) return;
      setCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === token) {
        request.current = null;
        setLoading(false);
      }
    }
  }
  const profiles = [...builtins, ...value.custom_profiles];
  const selected = profiles.find((profile) => profile.id === value.profile_id);
  const custom = value.custom_profiles.find((profile) => profile.id === value.profile_id);
  const customModel = manualModel || (!POLISH_MODELS.includes(value.model) && !catalog?.includes(value.model));
  const knownEfforts = Object.hasOwn(POLISH_MODEL_EFFORTS, value.model) ? POLISH_MODEL_EFFORTS[value.model] : undefined;
  const efforts = knownEfforts ?? POLISH_EFFORTS;
  const incompatibleEffort = value.effort !== null && !efforts.includes(value.effort);
  const atProfileLimit = value.custom_profiles.length >= MAX_CUSTOM_POLISH_PROFILES;

  function addProfile(source?: PolishProfile) {
    if (atProfileLimit) return;
    const profile: PolishProfile = {
      id: createPolishProfileId(profiles),
      name: source ? `${[...source.name].slice(0, 72).join('')} — копия` : 'Новый профиль',
      mode: source?.mode ?? 'llm',
      instruction: source?.instruction ?? '',
      prefix: source?.prefix ?? '',
      suffix: source?.suffix ?? '',
    };
    onChange({ ...value, profile_id: profile.id, custom_profiles: [...value.custom_profiles, profile] });
  }

  function editProfile(field: 'name' | 'instruction' | 'prefix' | 'suffix', text: string) {
    onChange({ ...value, custom_profiles: value.custom_profiles.map((profile) =>
      profile.id === custom?.id ? { ...profile, [field]: text } : profile) });
  }

  function editProfileMode(mode: PolishProfile['mode']) {
    onChange({ ...value, custom_profiles: value.custom_profiles.map((profile) =>
      profile.id === custom?.id ? { ...profile, mode } : profile) });
  }

  function toggleFavorite(id: string, checked: boolean) {
    onChange({
      ...value,
      favorite_profile_ids: checked
        ? [...value.favorite_profile_ids, id]
        : value.favorite_profile_ids.filter((favoriteId) => favoriteId !== id),
    });
  }

  return (
    <section aria-labelledby="polish-heading">
      <div className="section-heading"><h2 id="polish-heading">Обработка текста</h2></div>
      <p className="section-description">Профиль может обработать распознанный текст через OpenAI — это дополнительный платный запрос —
        или локально добавить фиксированный префикс и суффикс без дополнительного запроса. По умолчанию обработка выключена.
        Настройки применяются к новым записям, а не к последнему результату.</p>
      <div className="field">
        <label htmlFor="polish-profile">Профиль обработки текста</label>
        <select id="polish-profile" value={value.profile_id ?? ''}
          onChange={(event) => onChange({ ...value, profile_id: event.target.value || null })}>
          <option value="">Выключено</option>
          <optgroup label="Встроенные профили">
            {builtins.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </optgroup>
          <optgroup label="Мои профили">
            {value.custom_profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name || 'Без названия'}</option>)}
          </optgroup>
        </select>
        <p className="help">Встроенные профили и их инструкции заданы приложением и доступны только для чтения.</p>
      </div>
      <fieldset className="field favorite-profiles" aria-describedby="favorite-profiles-help">
        <legend>Избранные профили для переключения</legend>
        <div className="favorite-profile-list">
          {profiles.map((profile) => <label className="checkbox-label" key={profile.id}>
            <input type="checkbox" checked={value.favorite_profile_ids.includes(profile.id)}
              aria-label={`Избранный профиль: ${profile.name || 'Без названия'}`}
              onChange={(event) => toggleFavorite(profile.id, event.target.checked)} />
            <span aria-hidden="true">{value.favorite_profile_ids.includes(profile.id) ? '★' : '☆'}</span>
            <span>{profile.name || 'Без названия'}</span>
          </label>)}
        </div>
        <p className="help" id="favorite-profiles-help">«Выключено» всегда участвует в цикле. Один избранный профиль превращает переключение в тумблер между ним и «Выключено».</p>
      </fieldset>
      {selected && <div className="field">
        {custom ? <>
          <label htmlFor="polish-name">Название профиля</label>
          <input id="polish-name" value={custom.name} onChange={(event) => editProfile('name', event.target.value)} />
          <label htmlFor="polish-mode">Способ обработки</label>
          <select id="polish-mode" value={custom.mode}
            onChange={(event) => editProfileMode(event.target.value as PolishProfile['mode'])}>
            <option value="llm">Обработать через OpenAI</option>
            <option value="local">Только добавить префикс и суффикс</option>
          </select>
        </> : <p className="help">Способ обработки: дополнительный запрос к OpenAI.</p>}
        {selected.mode === 'llm' && <>
          <label htmlFor="polish-instruction">Инструкция профиля</label>
          <textarea id="polish-instruction" className="transcript" rows={5} value={selected.instruction}
            readOnly={!custom} maxLength={8000} onChange={(event) => editProfile('instruction', event.target.value)} />
        </>}
        {custom && <>
          <label htmlFor="polish-prefix">Префикс</label>
          <textarea id="polish-prefix" className="transcript" rows={3} value={custom.prefix} maxLength={8000}
            onChange={(event) => editProfile('prefix', event.target.value)} />
          <label htmlFor="polish-suffix">Суффикс</label>
          <textarea id="polish-suffix" className="transcript" rows={3} value={custom.suffix} maxLength={8000}
            onChange={(event) => editProfile('suffix', event.target.value)} />
          <p className="help">Пробелы и переносы строк сохраняются буквально. Префикс и суффикс добавляются последними:
            к сырой расшифровке в локальном профиле или к успешному результату OpenAI.</p>
          {custom.mode === 'local' && <p className="help">Локальный профиль не отправляет текст на дополнительную обработку OpenAI.</p>}
        </>}
      </div>}
      <div className="field form-actions">
        <button type="button" className="button button-secondary button-small" disabled={atProfileLimit} onClick={() => addProfile()}>Создать профиль</button>
        {selected && <button type="button" className="button button-secondary button-small" disabled={atProfileLimit}
          onClick={() => addProfile(selected)}>Дублировать профиль</button>}
        {custom && <button type="button" className="button button-danger-quiet button-small"
          onClick={() => onChange({ ...value, profile_id: null,
            custom_profiles: value.custom_profiles.filter((profile) => profile.id !== custom.id),
            favorite_profile_ids: value.favorite_profile_ids.filter((id) => id !== custom.id) })}>Удалить профиль</button>}
      </div>
      <div className="field">
        <label htmlFor="polish-model">Модель обработки текста</label>
        <select id="polish-model" value={customModel ? '__custom__' : value.model}
          onChange={(event) => {
            const manual = event.target.value === '__custom__';
            setManualModel(manual);
            if (!manual) onChange({ ...value, model: event.target.value });
          }}>
          <optgroup label="Модели с документированными возможностями">
            {POLISH_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}
          </optgroup>
          {catalog !== null && <optgroup label="Каталог OpenAI — совместимость не проверена">
            {catalog.map((model) => <option key={model} value={model}>{model}</option>)}
          </optgroup>}
          <option value="__custom__">Свой ID модели обработки…</option>
        </select>
        {customModel && <>
          <label htmlFor="polish-model-id">ID модели обработки OpenAI</label>
          <input id="polish-model-id" value={value.model} maxLength={128} spellCheck={false}
            autoComplete="off" autoCapitalize="none" onChange={(event) => onChange({ ...value, model: event.target.value })} />
        </>}
        <p className="help">Одна модель для всех профилей. Доступность зависит от модели и вашего API-ключа.
          Каталог /models не гарантирует совместимость с обработкой текста.</p>
        <button type="button" className="button button-secondary button-small" disabled={!hasApiKey || loading}
          onClick={() => void refreshModels()}>Обновить модели OpenAI</button>
        {!hasApiKey && <p className="help">Для обновления каталога сохраните API-ключ. Свой ID можно указать без ключа.</p>}
        {loading && <p className="help" role="status">Загрузка моделей OpenAI…</p>}
        {catalogError && <p className="notice notice-error" role="alert">Не удалось обновить модели OpenAI: {catalogError}</p>}
        {catalog !== null && !loading && <p className="help" role="status">{catalog.length
          ? `Моделей в каталоге, кроме встроенных: ${catalog.length}.`
          : 'Нет дополнительных моделей в каталоге OpenAI. Можно указать свой ID.'}</p>}
      </div>
      <div className="field">
        <label htmlFor="polish-effort">Уровень рассуждения</label>
        <select id="polish-effort" value={value.effort ?? ''} aria-describedby="polish-effort-help"
          onChange={(event) => onChange({ ...value, effort: event.target.value || null })}>
          <option value="">По умолчанию (не передавать параметр)</option>
          {incompatibleEffort && <option value={value.effort!}>{value.effort} — сохранённое значение</option>}
          {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
        {incompatibleEffort && <p className="help" role="alert">Уровень «{value.effort}» не поддерживается выбранной моделью по документации.
          Значение сохранено без изменений; выберите совместимый уровень перед использованием.</p>}
        <p className="help" id="polish-effort-help">{!knownEfforts && 'Возможности этой модели не проверены: /models не содержит метаданных об уровнях рассуждения. '}
          Доступность уровней зависит от модели. «По умолчанию» не передаёт
          параметр в OpenAI; «none» передаётся явно и не равнозначен значению по умолчанию.</p>
      </div>
      <p className="help field">До 32 пользовательских профилей; название — до 80 символов, инструкция, префикс
              и суффикс — до 8000 каждый. Создание, изменение и удаление профилей применяются кнопкой «Сохранить настройки».</p>
    </section>
  );
}
