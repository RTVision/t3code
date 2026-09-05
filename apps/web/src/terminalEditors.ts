import type {
  EnvironmentId,
  TerminalEditorCapability,
  TerminalEditorProbeInput,
} from "@t3tools/contracts";
import { terminalEditorConnectionRef } from "@t3tools/client-runtime/editor-choice";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { environmentCatalog } from "./connection/catalog";
import { useEnvironmentPresentation } from "./state/presentation";
import { useEnvironmentQuery } from "./state/query";

const CHECKING: TerminalEditorCapability = {
  state: "checking",
  message: "Checking Neovim…",
  preferenceKey: "",
  routeGeneration: "",
  terminals: [],
  selectedTerminal: null,
  executableOverride: null,
};
const DISCONNECTED: TerminalEditorCapability = {
  ...CHECKING,
  state: "unavailable",
  reason: "disconnected",
  message: "Connect the environment to check Neovim.",
};
const cache = new Map<string, { expires: number; result: Promise<TerminalEditorCapability> }>();
let revision = 0;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function invalidateTerminalEditors() {
  cache.clear();
  revision++;
  for (const listener of listeners) listener();
}
function probe(input: TerminalEditorProbeInput) {
  const key = JSON.stringify(input);
  const existing = cache.get(key);
  if (existing && existing.expires > performance.now()) return existing.result;
  const bridge = window.desktopBridge?.probeTerminalEditor;
  if (!bridge)
    return Promise.resolve({
      ...CHECKING,
      state: "unavailable" as const,
      reason: "desktop-required" as const,
      message: "Neovim (Terminal) requires a desktop app with terminal editor support.",
    });
  const entry = {
    expires: Infinity,
    result: bridge(input).catch((error: unknown): TerminalEditorCapability => ({
      ...CHECKING,
      state: "unavailable",
      reason: "probe-error",
      message: error instanceof Error ? error.message : "Could not check Neovim.",
    })),
  };
  cache.set(key, entry);
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  void entry.result.then((value) => {
    entry.expires = performance.now() + (value.state === "available" ? 60_000 : 5_000);
  });
  return entry.result;
}

export function useTerminalEditor(environmentId: EnvironmentId | null) {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const { data: connectionState } = useEnvironmentQuery(
    environmentId ? environmentCatalog.stateAtom(environmentId) : null,
  );
  const connection = useMemo(
    () => terminalEditorConnectionRef(presentation?.entry.target ?? null, environmentId),
    [presentation?.entry.target, environmentId],
  );
  const generation = String(connectionState?.generation ?? 0);
  const connected = presentation?.connection.phase === "connected";
  const input = useMemo(
    () => (connection ? { connection, connectionGeneration: generation } : null),
    [connection, generation],
  );
  const currentRevision = useSyncExternalStore(subscribe, () => revision);
  const key = JSON.stringify([input, currentRevision]);
  const [response, setResponse] = useState<{ key: string; value: TerminalEditorCapability } | null>(
    null,
  );
  const refresh = useCallback(
    async (rescan = false) => {
      if (!connected || !input) return DISCONNECTED;
      return probe({ ...input, ...(rescan ? { rescan: true } : {}) });
    },
    [connected, input],
  );
  useEffect(() => {
    let stale = false;
    void refresh().then((value) => {
      if (!stale) setResponse({ key, value });
    });
    return () => {
      stale = true;
    };
  }, [refresh, key]);
  const capability = !connected ? DISCONNECTED : response?.key === key ? response.value : CHECKING;
  const rescan = useCallback(async () => {
    await refresh(true);
    invalidateTerminalEditors();
  }, [refresh]);
  return useMemo(
    () => ({ capability, connection, generation, connected, refresh, rescan }),
    [capability, connection, generation, connected, refresh, rescan],
  );
}
