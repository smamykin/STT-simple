import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { backend } from './backend';
import { makeSnapshot } from './testFixtures';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe('Tauri command contract', () => {
  it('uses the exact command names for no-argument operations', async () => {
    const commands = [
      [backend.getSnapshot, 'get_snapshot'],
      [backend.listInputDevices, 'list_input_devices'],
      [backend.listOpenAiModels, 'list_openai_models'],
      [backend.deleteApiKey, 'delete_api_key'],
      [backend.toggleRecording, 'toggle_recording'],
      [backend.toggleSpeech, 'toggle_speech'],
      [backend.cancelRecording, 'cancel_recording'],
      [backend.resetStatistics, 'reset_statistics'],
      [backend.copyLastTranscript, 'copy_last_transcript'],
      [backend.retryPolish, 'retry_polish'],
      [backend.cyclePolishProfile, 'cycle_polish_profile'],
      [backend.quitApp, 'quit_app'],
    ] as const;
    for (const [command, name] of commands) {
      await command();
      expect(invoke).toHaveBeenLastCalledWith(name);
    }
  });

  it('passes settings and apiKey using the backend argument names', async () => {
    const settings = makeSnapshot().settings;
    const saved = makeSnapshot();
    vi.mocked(invoke).mockResolvedValue(saved);
    await expect(backend.saveSettings(settings)).resolves.toBe(saved);
    expect(invoke).toHaveBeenLastCalledWith('save_settings', { settings });
    await expect(backend.setApiKey('test-only-key')).resolves.toBe(saved);
    expect(invoke).toHaveBeenLastCalledWith('set_api_key', { apiKey: 'test-only-key' });
  });

  it('subscribes to app-state payloads and returns the real cleanup function', async () => {
    const cleanup = vi.fn();
    vi.mocked(listen).mockResolvedValue(cleanup);
    const onSnapshot = vi.fn();
    expect(await backend.subscribe(onSnapshot)).toBe(cleanup);
    expect(listen).toHaveBeenCalledWith('app-state', expect.any(Function));
    const callback = vi.mocked(listen).mock.calls[0]?.[1];
    const payload = makeSnapshot({ phase: 'recording' });
    callback?.({ event: 'app-state', id: 1, payload });
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(payload);
  });
});
