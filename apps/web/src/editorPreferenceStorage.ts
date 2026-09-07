import * as Schema from "effect/Schema";
import { useCallback, useMemo, useSyncExternalStore } from "react";

const values = new Map<string, string | null>();
const listeners = new Map<string, Set<() => void>>();
const changeEvent = "t3code:local_storage_change";
function read(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function snapshot(key: string) {
  if (!values.has(key)) values.set(key, read(key));
  return values.get(key) ?? null;
}
function refresh(key: string) {
  if (!listeners.has(key)) {
    values.delete(key);
    return;
  }
  const next = read(key);
  if (values.get(key) === next) return;
  values.set(key, next);
  for (const listener of listeners.get(key) ?? []) listener();
}
function onStorage(event: StorageEvent) {
  if (event.key === null) {
    for (const key of listeners.keys()) refresh(key);
  } else refresh(event.key);
}
function onLocalChange(event: Event) {
  refresh((event as CustomEvent<{ key: string }>).detail.key);
}
// All editor consumers share two browser listeners and cached serialized snapshots.
function subscribe(key: string, listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    window.addEventListener(changeEvent, onLocalChange);
  }
  let entry = listeners.get(key);
  if (!entry) {
    entry = new Set();
    listeners.set(key, entry);
    refresh(key);
  }
  entry.add(listener);
  return () => {
    entry.delete(listener);
    if (entry.size === 0) listeners.delete(key);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(changeEvent, onLocalChange);
      values.clear();
    }
  };
}
export function useEditorPreference<T, E>(
  key: string,
  initial: T,
  schema: Schema.Codec<T, E>,
): [T, (value: T) => void] {
  const getSnapshot = useCallback(() => snapshot(key), [key]);
  const watch = useCallback((listener: () => void) => subscribe(key, listener), [key]);
  const serialized = useSyncExternalStore(watch, getSnapshot, getSnapshot);
  const value = useMemo(() => {
    if (serialized === null) return initial;
    try {
      return Schema.decodeSync(Schema.fromJsonString(schema))(serialized);
    } catch {
      return initial;
    }
  }, [serialized, initial, schema]);
  const set = useCallback(
    (next: T) => {
      try {
        const serialized =
          next === null ? null : Schema.encodeSync(Schema.fromJsonString(schema))(next);
        if (snapshot(key) === serialized) return;
        if (serialized === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, serialized);
        window.dispatchEvent(new CustomEvent(changeEvent, { detail: { key } }));
      } catch (error) {
        console.error("Could not save editor preference.", error);
      }
    },
    [key, schema],
  );
  return [value, set];
}
