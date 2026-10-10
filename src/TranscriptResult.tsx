import { useEffect, useRef, useState } from 'react';
import { backend } from './backend';
import type { Action, Snapshot } from './types';
import { canRunAction } from './utils';

export function TranscriptResult({ snapshot, connected, pending, runAction, autoPaste, mac, linux }: {
  snapshot: Snapshot | null;
  connected: boolean;
  pending: Action | null;
  runAction: (action: Action, command: () => Promise<Snapshot | void>) => Promise<boolean>;
  autoPaste: boolean;
  mac: boolean;
  linux: boolean;
}) {
  const [rawExpanded, setRawExpanded] = useState(false);
  const [copied, setCopied] = useState<'final' | 'raw' | null>(null);
  const raw = snapshot?.last_raw_transcript ?? '';
  const final = snapshot?.last_transcript ?? '';
  const hasPendingPolish = snapshot?.has_pending_polish ?? false;
  const failed = hasPendingPolish && snapshot?.phase !== 'polishing';
  const previous = snapshot?.previous_transcript ?? '';
  const resultRevision = useRef(0);
  const processing = snapshot?.phase === 'transcribing' || snapshot?.phase === 'polishing';
  const newRecording = snapshot?.phase === 'recording' || snapshot?.phase === 'transcribing';
  const showRaw = hasPendingPolish || rawExpanded;
  const disabled = !connected || pending !== null;

  useEffect(() => {
    resultRevision.current += 1;
    setCopied(null);
  }, [raw, final, snapshot?.phase, connected]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 4000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(kind: 'final' | 'raw') {
    setCopied(null);
    const revision = resultRevision.current;
    const action = kind === 'final' ? 'copy_last_transcript' : 'copy_last_raw_transcript';
    const command = kind === 'final' ? backend.copyLastTranscript : backend.copyLastRawTranscript;
    if (await runAction(action, command) && revision === resultRevision.current) setCopied(kind);
  }

  return (
    <section className="card transcript-card" aria-labelledby="transcript-heading">
      <div className="section-heading">
        <h2 id="transcript-heading">Последний результат</h2>
        {!failed && <div className="copy-action">
          <span className="copy-feedback" role="status">{copied === 'final' ? 'Скопировано' : ''}</span>
          <button className="button button-secondary button-small"
            disabled={disabled || !canRunAction('copy_last_transcript', snapshot)}
            onClick={() => void copy('final')}>
            {pending === 'copy_last_transcript' ? 'Копирование…' : 'Скопировать'}
          </button>
        </div>}
      </div>

      {failed ? <>
        <div className="result-warning" role="status">
          <strong>Обработка текста не завершена</strong>
          <p>Исходная расшифровка сохранена. Скопируйте её или повторите обработку.</p>
        </div>

      </> : <>
        {final && <p className="result-context">{newRecording
          ? 'Показан предыдущий успешный результат. Новая запись ещё не распознана.'
          : 'Последний успешный итоговый текст'}</p>}
        <label className="visually-hidden" htmlFor="transcript">Текст последней диктовки</label>
        <textarea id="transcript" className="transcript" readOnly rows={6} value={final}
          placeholder={processing ? 'Здесь появится результат после завершения обработки.' : 'Начните диктовку — здесь появится готовый текст.'}
          aria-describedby="transcript-help" />
        {processing && <p className="help" role="status">{snapshot?.phase === 'polishing'
          ? 'Обрабатываем исходную расшифровку…' : 'Распознаём новую запись…'}</p>}
      </>}

      {previous && <details className="previous-result">
        <summary>Предыдущий успешный результат</summary>
        <label className="visually-hidden" htmlFor="previous-transcript">Предыдущий успешный текст</label>
        <textarea id="previous-transcript" className="transcript" readOnly rows={4} value={previous} />
        <p className="help">Это результат предыдущей записи, а не текущей расшифровки.</p>
      </details>}

      {Boolean(raw) && <div className="raw-result">
        {!hasPendingPolish && <button type="button" className="text-button" aria-expanded={showRaw} aria-controls="raw-result-content"
          onClick={() => setRawExpanded((value) => !value)}>
          {showRaw ? 'Скрыть исходный текст' : 'Показать исходный текст'}
        </button>}
        <div id="raw-result-content" hidden={!showRaw}>
          <div className="field-heading">
            <label htmlFor="raw-transcript">Исходный текст распознавания</label>
            <div className="copy-action">
              <span className="copy-feedback" role="status">{copied === 'raw' ? 'Исходный текст скопирован' : ''}</span>
              <button className="button button-secondary button-small"
                disabled={disabled || !canRunAction('copy_last_raw_transcript', snapshot)}
                onClick={() => void copy('raw')}>
                {pending === 'copy_last_raw_transcript' ? 'Копирование исходного…' : 'Скопировать исходный'}
              </button>
            </div>
          </div>
          <textarea id="raw-transcript" className="transcript" readOnly rows={5} value={raw} />
        </div>
      </div>}

      {hasPendingPolish && <div className="retry-polish">
        <button className="button button-secondary" aria-describedby="retry-polish-help"
          disabled={disabled || !canRunAction('retry_polish', snapshot)}
          onClick={() => void runAction('retry_polish', backend.retryPolish)}>
          {pending === 'retry_polish' ? 'Повтор…' : 'Повторить обработку текста'}
        </button>
        <p className="help" id="retry-polish-help">Повтор использует настройки неудавшейся задачи,
          а не текущие настройки. Успешный результат только копируется, без автоматической вставки.
          Это дополнительный платный запрос в OpenAI.</p>
      </div>}
      <p className="help" id="transcript-help">{(mac || linux) && autoPaste
        ? 'При записи, начатой глобальным hotkey и остановленной hotkey или автоматически по лимиту, текст автоматически вставляется в активное поле на момент завершения распознавания и обработки текста и остаётся в буфере обмена.'
        : 'Текст копируется в буфер обмена — вставьте его рабочим для целевого поля сочетанием: Cmd+V на macOS, Ctrl+V или Ctrl+Shift+V на Linux.'}</p>
      <details className="result-privacy">
        <summary>Хранение текста</summary>
        <p className="help">Исходный и итоговый текст хранятся только в памяти приложения и удаляются после выхода.</p>
      </details>
    </section>
  );
}
