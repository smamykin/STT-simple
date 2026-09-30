import { describe, expect, it, vi } from 'vitest';
import { createSnapshotConnection } from './snapshotConnection';
import { deferred, makeSnapshot } from './testFixtures';
import type { Snapshot } from './types';

function setup(readSnapshot: () => Promise<Snapshot> = async () => makeSnapshot()) {
  let listener: (snapshot: Snapshot) => void = () => {};
  const cleanup = vi.fn();
  const onSnapshot = vi.fn();
  const onReady = vi.fn();
  const onError = vi.fn();
  const read = vi.fn(readSnapshot);
  const subscribe = vi.fn(async (callback: (snapshot: Snapshot) => void) => {
    listener = callback;
    return cleanup;
  });
  const connection = createSnapshotConnection({ subscribe, read, onSnapshot, onReady, onError });
  return { connection, read, subscribe, cleanup, onSnapshot, onReady, onError, emit: (snapshot: Snapshot) => listener(snapshot) };
}

describe('snapshot connection', () => {
  it('waits for the listener before reading the initial snapshot', async () => {
    const listenerReady = deferred<() => void>();
    const read = vi.fn(async () => makeSnapshot());
    const connection = createSnapshotConnection({
      subscribe: () => listenerReady.promise,
      read, onSnapshot: vi.fn(), onReady: vi.fn(), onError: vi.fn(),
    });
    const starting = connection.start();
    expect(read).not.toHaveBeenCalled();
    listenerReady.resolve(vi.fn());
    await starting;
    expect(read).toHaveBeenCalledOnce();
    connection.dispose();
  });

  it('unlistens exactly once if disposed before listen resolves (StrictMode)', async () => {
    const listenerReady = deferred<() => void>();
    const cleanup = vi.fn();
    const read = vi.fn(async () => makeSnapshot());
    const onReady = vi.fn();
    const connection = createSnapshotConnection({
      subscribe: () => listenerReady.promise,
      read, onSnapshot: vi.fn(), onReady, onError: vi.fn(),
    });
    const starting = connection.start();
    connection.dispose();
    connection.dispose();
    listenerReady.resolve(cleanup);
    await starting;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(connection.ready).toBe(false);
  });

  it('ignores an initial snapshot that is older than an event', async () => {
    const response = deferred<Snapshot>();
    const app = setup(() => response.promise);
    const starting = app.connection.start();
    await vi.waitFor(() => expect(app.read).toHaveBeenCalledOnce());
    const event = makeSnapshot({ phase: 'recording', recording_seconds: 3 });
    app.emit(event);
    response.resolve(makeSnapshot());
    await starting;
    expect(app.onSnapshot).toHaveBeenCalledExactlyOnceWith(event);
    app.connection.dispose();
  });

  it('shares in-flight reads rather than overlapping polls', async () => {
    const app = setup();
    await app.connection.start();
    const response = deferred<Snapshot>();
    app.read.mockImplementationOnce(() => response.promise);
    const first = app.connection.refresh();
    const second = app.connection.refresh();
    expect(app.read).toHaveBeenCalledTimes(2);
    response.resolve(makeSnapshot({ phase: 'recording', recording_seconds: 8 }));
    await Promise.all([first, second]);
    expect(app.read).toHaveBeenCalledTimes(2);
    expect(app.onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ recording_seconds: 8 }));
    app.connection.dispose();
  });

  it('rejects pre-command reads and reconciles again after the pending read', async () => {
    const app = setup();
    await app.connection.start();
    app.onSnapshot.mockClear();
    const oldRead = deferred<Snapshot>();
    const current = makeSnapshot({ phase: 'recording' });
    app.read.mockImplementationOnce(() => oldRead.promise).mockResolvedValueOnce(current);
    const polling = app.connection.refresh();
    app.connection.beginMutation();
    await app.connection.refresh();
    expect(app.read).toHaveBeenCalledTimes(2);
    app.connection.endMutation();
    const reconciling = app.connection.refresh(true);
    oldRead.resolve(makeSnapshot());
    await Promise.all([polling, reconciling]);
    expect(app.read).toHaveBeenCalledTimes(3);
    expect(app.onSnapshot).toHaveBeenCalledExactlyOnceWith(current);
    app.connection.dispose();
  });

  it('does not overwrite a newer event with a command response', async () => {
    const app = setup();
    await app.connection.start();
    app.onSnapshot.mockClear();
    const revision = app.connection.beginMutation();
    const current = makeSnapshot({ phase: 'transcribing' });
    app.emit(current);
    app.connection.acceptMutation(makeSnapshot({ phase: 'recording' }), revision);
    app.connection.endMutation();
    expect(app.onSnapshot).toHaveBeenCalledExactlyOnceWith(current);
    app.connection.dispose();
  });

  it('accepts a command snapshot when no newer event exists', async () => {
    const app = setup();
    await app.connection.start();
    const revision = app.connection.beginMutation();
    const saved = makeSnapshot({ has_api_key: false });
    app.connection.acceptMutation(saved, revision);
    app.connection.endMutation();
    expect(app.onSnapshot).toHaveBeenLastCalledWith(saved);
    app.connection.dispose();
  });

  it('ignores events and read completion after disposal', async () => {
    const app = setup();
    await app.connection.start();
    app.onSnapshot.mockClear();
    const response = deferred<Snapshot>();
    app.read.mockImplementationOnce(() => response.promise);
    const polling = app.connection.refresh();
    app.connection.dispose();
    app.emit(makeSnapshot({ phase: 'recording' }));
    response.resolve(makeSnapshot());
    await polling;
    expect(app.onSnapshot).not.toHaveBeenCalled();
    expect(app.cleanup).toHaveBeenCalledOnce();
  });

  it('reports initial read failure without unhandled rejections', async () => {
    const app = setup(async () => { throw new Error('Keyring unavailable'); });
    await app.connection.start();
    expect(app.onError).toHaveBeenCalledWith(expect.stringContaining('Keyring unavailable'));
    expect(app.connection.ready).toBe(true);
    app.connection.dispose();
  });

  it('reports listener failure and never starts a read', async () => {
    const read = vi.fn(async () => makeSnapshot());
    const onError = vi.fn();
    const connection = createSnapshotConnection({
      subscribe: async () => { throw new Error('Permission denied'); },
      read, onSnapshot: vi.fn(), onReady: vi.fn(), onError,
    });
    await connection.start();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
    expect(connection.ready).toBe(false);
    expect(read).not.toHaveBeenCalled();
    connection.dispose();
  });
});
