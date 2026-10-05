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
    const profile = {
      id: createPolishProfileId(profiles),
      name: source ? `${[...source.name].slice(0, 72).join('')} — копия` : 'Новый профиль',
      instruction: source?.instruction ?? '',
    };
    onChange({ ...value, profile_id: profile.id, custom_profiles: [...value.custom_profiles, profile] });
  }

  function editProfile(field: 'name' | 'instruction', text: string) {
    onChange({ ...value, custom_profiles: value.custom_profiles.map((profile) =>
      profile.id === custom?.id ? { ...profile, [field]: text } : profile) });
  }

  return (
    <section aria-labelledby="polish-heading">
      <div className="section-heading"><h2 id="polish-heading">Обработка текста</h2></div>
      <p className="section-description">После распознавания текст и инструкция отправляются в OpenAI:
        это дополнительный платный запрос. По умолчанию обработка выключена.
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
      {selected && <div className="field">
        {custom && <>
          <label htmlFor="polish-name">Название профиля</label>
          <input id="polish-name" value={custom.name} onChange={(event) => editProfile('name', event.target.value)} />
        </>}
        <label htmlFor="polish-instruction">Инструкция профиля</label>
        <textarea id="polish-instruction" className="transcript" rows={5} value={selected.instruction}
          readOnly={!custom} onChange={(event) => editProfile('instruction', event.target.value)} />
      </div>}
      <div className="field form-actions">
        <button type="button" className="button button-secondary button-small" disabled={atProfileLimit} onClick={() => addProfile()}>Создать профиль</button>
        {selected && <button type="button" className="button button-secondary button-small" disabled={atProfileLimit}
          onClick={() => addProfile(selected)}>Дублировать профиль</button>}
        {custom && <button type="button" className="button button-danger-quiet button-small"
          onClick={() => onChange({ ...value, profile_id: null,
            custom_profiles: value.custom_profiles.filter((profile) => profile.id !== custom.id) })}>Удалить профиль</button>}
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
      <p className="help field">До 32 пользовательских профилей, название — до 80 символов, инструкция — до 8000.
              Создание, изменение и удаление профилей применяются кнопкой «Сохранить настройки».</p>
    </section>
  );
}
