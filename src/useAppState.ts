import { useCallback, useEffect, useRef, useState } from 'react';
import { backend, inTauri } from './backend';
import { createSnapshotConnection } from './snapshotConnection';
import type { SnapshotConnection } from './snapshotConnection';
import type { Action, InputDevice, Snapshot } from './types';
import { canRunAction, errorMessage } from './utils';

const ACTION_LABELS: Record<Action, string> = {
  save_settings: 'Не удалось сохранить настройки',
  set_api_key: 'Не удалось сохранить API-ключ',
  delete_api_key: 'Не удалось удалить API-ключ',
  toggle_recording: 'Не удалось начать или остановить запись',
  cancel_recording: 'Не удалось отменить запись',
  reset_statistics: 'Не удалось сбросить статистику',
  copy_last_transcript: 'Не удалось скопировать текст',
  quit_app: 'Не удалось закрыть приложение',
};

export function useAppState() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const connectionRef = useRef<SnapshotConnection | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const pendingRef = useRef<Action | null>(null);
  const lastActionRef = useRef<{ action: Action; time: number } | null>(null);
  const devicesLoadingRef = useRef(false);

  const refreshDevices = useCallback(async () => {
    const connection = connectionRef.current;
    if (!connection?.ready || devicesLoadingRef.current) return;
    devicesLoadingRef.current = true;
    setDevicesLoading(true);
    setDeviceError(null);
    try {
      const result = await backend.listInputDevices();
      if (connectionRef.current === connection && connection.ready) setDevices(result);
    } catch (error) {
      if (connectionRef.current === connection && connection.ready) {
        setDeviceError(`Не удалось получить микрофоны: ${errorMessage(error)}. Проверьте подключение и разрешения, затем обновите список.`);
      }
    } finally {
      if (connectionRef.current === connection && connection.ready) {
        devicesLoadingRef.current = false;
        setDevicesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!inTauri) return;
    snapshotRef.current = null;
    pendingRef.current = null;
    devicesLoadingRef.current = false;
    setSnapshot(null);
    setConnected(false);
    setPending(null);
    setSyncError(null);
    setActionError(null);
    setDevicesLoading(false);
    const connection = createSnapshotConnection({
      subscribe: backend.subscribe,
      read: backend.getSnapshot,
      onSnapshot: (next) => {
        snapshotRef.current = next;
        setSnapshot(next);
        setSyncError(null);
      },
      onReady: () => setConnected(true),
      onError: setSyncError,
    });
    connectionRef.current = connection;
    void connection.start().then(() => {
      if (connectionRef.current === connection && connection.ready) void refreshDevices();
    });
    return () => {
      connection.dispose();
      if (connectionRef.current === connection) connectionRef.current = null;
    };
  }, [attempt, refreshDevices]);

  useEffect(() => {
    if (snapshot?.phase !== 'recording') return;
    const connection = connectionRef.current;
    if (!connection?.ready) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await connection.refresh();
      if (!stopped) timer = setTimeout(() => void tick(), 1000);
    };
    timer = setTimeout(() => void tick(), 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [snapshot?.phase, connected, attempt]);

  const runAction = useCallback(async (
    action: Action,
    command: () => Promise<Snapshot | void>,
  ): Promise<boolean> => {
    const connection = connectionRef.current;
    if (!connection?.ready || pendingRef.current) return false;
    if (!canRunAction(action, snapshotRef.current)) {
      setActionError(action === 'toggle_recording' && !snapshotRef.current?.has_api_key
        ? 'Сначала сохраните API-ключ OpenAI в настройках.'
        : 'Действие сейчас недоступно. Дождитесь завершения обработки записи.');
      return false;
    }
    const now = performance.now();
    const lastAction = lastActionRef.current;
    // Also absorb double clicks when a local command resolves almost instantly.
    if (lastAction?.action === action && now - lastAction.time < 400) return false;
    lastActionRef.current = { action, time: now };
    pendingRef.current = action;
    setPending(action);
    setActionError(null);
    const revision = connection.beginMutation();
    try {
      const result = await command();
      if (connectionRef.current !== connection || !connection.ready) return false;
      connection.acceptMutation(result, revision);
      return true;
    } catch (error) {
      if (connectionRef.current === connection && connection.ready) {
        setActionError(`${ACTION_LABELS[action]}: ${errorMessage(error)}. Проверьте настройки и повторите действие.`);
      }
      return false;
    } finally {
      connection.endMutation();
      if (connectionRef.current === connection && connection.ready) {
        // Keep the action locked until reconciliation: another toggle against an
        // old idle snapshot could stop the recording we have just started.
        await connection.refresh(true);
        if (connectionRef.current === connection && connection.ready) {
          pendingRef.current = null;
          setPending(null);
        }
      }
    }
  }, []);

  return {
    snapshot,
    connected,
    syncError,
    actionError,
    pending,
    devices,
    devicesLoading,
    deviceError,
    refreshDevices,
    runAction,
    retry: () => setAttempt((value) => value + 1),
  };
}
