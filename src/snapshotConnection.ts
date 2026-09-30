import { errorMessage } from './utils';
import type { Snapshot } from './types';

type Unlisten = () => void;

interface ConnectionOptions {
  subscribe: (callback: (snapshot: Snapshot) => void) => Promise<Unlisten>;
  read: () => Promise<Snapshot>;
  onSnapshot: (snapshot: Snapshot) => void;
  onReady: () => void;
  onError: (message: string) => void;
}

/** Events supersede reads and command responses already in flight. */
export function createSnapshotConnection(options: ConnectionOptions) {
  let disposed = false;
  let listening = false;
  let started = false;
  let readTask: Promise<void> | null = null;
  let mutating = false;
  let revision = 0;
  let unlisten: Unlisten | undefined;

  return {
    get ready() {
      return listening && !disposed;
    },

    async start(): Promise<void> {
      if (started || disposed) return;
      started = true;
      try {
        const cleanup = await options.subscribe((snapshot) => {
          if (disposed) return;
          revision += 1;
          options.onSnapshot(snapshot);
        });
        // StrictMode can dispose this connection before listen() resolves.
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        listening = true;
        options.onReady();
        await this.refresh();
      } catch (error) {
        if (!disposed) {
          options.onError(`Не удалось подписаться на состояние: ${errorMessage(error)}. Повторите подключение.`);
        }
      }
    },

    async refresh(afterPending = false): Promise<void> {
      if (disposed || !listening || mutating) return;
      if (readTask) {
        await readTask;
        if (afterPending) await this.refresh();
        return;
      }
      const atStart = revision;
      const task = (async () => {
        try {
          const snapshot = await options.read();
          if (!disposed && revision === atStart) options.onSnapshot(snapshot);
        } catch (error) {
          if (!disposed && revision === atStart) {
            options.onError(`Не удалось получить состояние: ${errorMessage(error)}. Проверьте доступ к системному хранилищу ключей и повторите подключение.`);
          }
        }
      })();
      readTask = task;
      try {
        await task;
      } finally {
        if (readTask === task) readTask = null;
      }
    },

    beginMutation(): number {
      mutating = true;
      revision += 1;
      return revision;
    },

    acceptMutation(snapshot: Snapshot | void, atStart: number): void {
      if (!disposed && snapshot && revision === atStart) options.onSnapshot(snapshot);
    },

    endMutation(): void {
      mutating = false;
      revision += 1;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      listening = false;
      unlisten?.();
      unlisten = undefined;
    },
  };
}

export type SnapshotConnection = ReturnType<typeof createSnapshotConnection>;
