import { useCallback, useEffect, useRef, useState } from 'react';

export const POLL_MS = 15_000;

export interface Polled<T> {
  /** The last good data; kept when a later refresh fails. */
  data?: T;
  /** Set while there is no data and the last load failed. */
  error?: string;
  /** Set when a refresh failed after data had loaded; cleared by the next success. */
  refreshError?: string;
  loading: boolean;
  /** Loads now. While a load is in flight it runs once more after it, so the caller sees a state from after its call. */
  refresh: () => Promise<void>;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `load()` now and every `ms`, never two at once. */
export function usePoll<T>(load: () => Promise<T>, ms = POLL_MS): Polled<T> {
  const [state, setState] = useState<Omit<Polled<T>, 'refresh'>>({ loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const run = useCallback((): Promise<void> => {
    const p = (async () => {
      do {
        again.current = false;
        try {
          const data = await loadRef.current();
          setState({ data, loading: false });
        } catch (e) {
          const message = errorMessage(e);
          setState((s) => (s.data !== undefined ? { ...s, loading: false, refreshError: message } : { loading: false, error: message }));
        }
      } while (again.current);
    })().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = p;
    return p;
  }, []);

  // A poll tick skips while a load is in flight.
  const tick = useCallback(() => {
    if (!inFlight.current) void run();
  }, [run]);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    setState((s) => (s.data === undefined ? { loading: true } : s));
    return run();
  }, [run]);

  useEffect(() => {
    tick();
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [tick, ms]);

  return { ...state, refresh };
}
