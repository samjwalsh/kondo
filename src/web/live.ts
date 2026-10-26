import { useCallback, useEffect, useRef, useState } from "react";
import type { KondoEvent } from "../shared/api.js";
import { api } from "./api.js";

/** Server events, plus a synthetic one when the stream reconnects (state may have moved on). */
export type UiEvent = KondoEvent | { type: "reconnected" };
type Handler = (event: UiEvent) => void;

const handlers = new Set<Handler>();
let source: EventSource | null = null;
let connectedBefore = false;

function connect(): void {
  if (source) return;
  source = new EventSource("/api/events");
  source.onopen = () => {
    if (connectedBefore) emit({ type: "reconnected" });
    connectedBefore = true;
  };
  source.onmessage = (message) => {
    try {
      emit(JSON.parse(message.data) as KondoEvent);
    } catch {
      // Ignore anything malformed.
    }
  };
}

function emit(event: UiEvent): void {
  for (const handler of handlers) handler(event);
}

export function useLiveEvents(handler: Handler): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    connect();
    const listener: Handler = (event) => ref.current(event);
    handlers.add(listener);
    return () => {
      handlers.delete(listener);
    };
  }, []);
}

/** GETs `path`, and re-fetches (debounced) whenever `refreshOn` matches a live event. */
export function useApi<T>(path: string, refreshOn?: (event: UiEvent) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      setData(await api.get<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);

  useEffect(() => {
    void reload();
    return () => window.clearTimeout(timer.current);
  }, [reload]);

  useLiveEvents((event) => {
    if (event.type === "reconnected" || refreshOn?.(event)) {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void reload(), 250);
    }
  });

  return { data, error, reload, setData };
}
