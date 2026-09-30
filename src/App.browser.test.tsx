// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';

const backend = vi.hoisted(() => ({ getSnapshot: vi.fn(), subscribe: vi.fn(), listInputDevices: vi.fn() }));
vi.mock('./backend', () => ({ inTauri: false, backend }));
afterEach(cleanup);

it('explains the desktop requirement without connecting or inventing browser state', () => {
  render(<StrictMode><App /></StrictMode>);
  expect(screen.getByRole('heading', { name: 'Диктовка в настольном приложении' })).toBeTruthy();
  expect(screen.getByText('npm run tauri dev')).toBeTruthy();
  expect(screen.getByText(/Этот интерфейс работает только внутри Tauri/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Начать запись' })).toBeNull();
  expect(backend.subscribe).not.toHaveBeenCalled();
  expect(backend.getSnapshot).not.toHaveBeenCalled();
  expect(backend.listInputDevices).not.toHaveBeenCalled();
});
