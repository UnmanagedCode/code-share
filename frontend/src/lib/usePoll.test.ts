import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { deferred } from '@/test/api';
import { POLL_MS, usePoll } from './usePoll';

afterEach(() => vi.useRealTimers());

// Invariant: a failed refresh keeps the last good data and reports refreshError; the next success clears it.
it('keeps the last data when a refresh fails', async () => {
  let n = 0;
  const load = vi.fn(async () => {
    n += 1;
    if (n === 2) throw new Error('blip');
    return n;
  });
  const { result } = renderHook(() => usePoll(load));
  await waitFor(() => expect(result.current.data).toBe(1));
  await act(() => result.current.refresh());
  expect(result.current).toMatchObject({ data: 1, refreshError: 'blip' });
  expect(result.current.error).toBeUndefined();
  await act(() => result.current.refresh());
  expect(result.current.data).toBe(3);
  expect(result.current.refreshError).toBeUndefined();
});

// Invariant: a first load that fails is an error with no data; refresh (Retry) loads again.
it('reports a failed first load and recovers on refresh', async () => {
  let ok = false;
  const { result } = renderHook(() => usePoll(async () => { if (!ok) throw new Error('down'); return 'up'; }));
  await waitFor(() => expect(result.current.error).toBe('down'));
  expect(result.current.loading).toBe(false);
  ok = true;
  await act(() => result.current.refresh());
  expect(result.current.data).toBe('up');
  expect(result.current.error).toBeUndefined();
});

// Invariant: a refresh asked for while a load is in flight runs once more afterwards (so an action sees state
// from after it), and poll ticks never start a second load while one is in flight.
it('never overlaps loads, and re-runs a refresh asked for mid-flight', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const gates = [deferred<number>(), deferred<number>()];
  let i = 0;
  const load = vi.fn(() => gates[i++].promise);
  const { result } = renderHook(() => usePoll(load));
  expect(load).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 2));
  expect(load).toHaveBeenCalledTimes(1);
  let refreshed = false;
  act(() => { void result.current.refresh().then(() => { refreshed = true; }); });
  await act(async () => gates[0].resolve(1));
  expect(load).toHaveBeenCalledTimes(2);
  expect(refreshed).toBe(false);
  await act(async () => gates[1].resolve(2));
  await waitFor(() => expect(refreshed).toBe(true));
  expect(result.current.data).toBe(2);
});
