"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

export interface Query<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  /** True during every request, including reloads and polls (loading is only the first load). */
  fetching: boolean;
  reload: () => void;
}

/** Minimal data hook: fetch on mount / when the path changes, optional polling for live views. */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}): Query<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [fetching, setFetching] = useState(!!path);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const first = useRef(true);

  useEffect(() => {
    first.current = true;
  }, [path]);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    if (first.current) setLoading(true);
    setFetching(true);
    api<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: ApiError) => !cancelled && setError(e))
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setFetching(false);
          first.current = false;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  useEffect(() => {
    if (!opts.pollMs || !path) return;
    const id = setInterval(() => document.visibilityState === "visible" && reload(), opts.pollMs);
    return () => clearInterval(id);
  }, [opts.pollMs, path, reload]);

  return { data, error, loading, fetching, reload };
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setValue(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, [key]);
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [value, set];
}
