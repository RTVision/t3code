import type {
  EnvironmentId,
  TerminalEditorCapability,
  TerminalEditorProbeInput,
} from "@t3tools/contracts";
import { terminalEditorConnectionRef } from "@t3tools/client-runtime/editor-choice";
import { useCallback, useMemo, useSyncExternalStore } from "react";
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
const DESKTOP_REQUIRED: TerminalEditorCapability = {
  ...CHECKING,
  state: "unavailable",
  reason: "desktop-required",
  message: "Neovim (Terminal) requires a desktop app with terminal editor support.",
};
const cache = new Map<
  string,
  {
    expires: number;
    value: TerminalEditorCapability;
    result: Promise<TerminalEditorCapability>;
  }
>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function notify() {
  for (const listener of listeners) listener();
}
export function invalidateTerminalEditors() {
  cache.clear();
  notify();
}
// Reading a capability never starts a probe. Only editor actions and discovery UI refresh it.
function probe(input: TerminalEditorProbeInput) {
  const key = JSON.stringify({
    connection: input.connection,
    connectionGeneration: input.connectionGeneration,
  });
  const existing = cache.get(key);
  if (!input.rescan && existing && existing.expires > performance.now()) return existing.result;
  const bridge = window.desktopBridge?.probeTerminalEditor;
  if (!bridge) return Promise.resolve(DESKTOP_REQUIRED);
  const entry = {
    expires: Infinity,
    value: CHECKING,
    result: Promise.resolve()
      .then(() => bridge(input))
      .catch((error: unknown): TerminalEditorCapability => ({
        ...CHECKING,
        state: "unavailable",
        reason: "probe-error",
        message: error instanceof Error ? error.message : "Could not check Neovim.",
      })),
  };
  cache.set(key, entry);
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  notify();
  void entry.result.then((value) => {
    if (cache.get(key) !== entry) return;
    entry.value = value;
    entry.expires = performance.now() + (value.state === "available" ? 60_000 : 5_000);
    notify();
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
  const key = JSON.stringify(input);
  const capability = useSyncExternalStore(
    subscribe,
    () => {
      if (!connected || !input) return DISCONNECTED;
      if (!window.desktopBridge?.probeTerminalEditor) return DESKTOP_REQUIRED;
      return cache.get(key)?.value ?? CHECKING;
    },
    () => DISCONNECTED,
  );
  const refresh = useCallback(
    async (rescan = false) => {
      if (!connected || !input) return DISCONNECTED;
      return probe({ ...input, ...(rescan ? { rescan: true } : {}) });
    },
    [connected, input],
  );
  const rescan = useCallback(() => refresh(true), [refresh]);
  return useMemo(
    () => ({ capability, connection, generation, connected, refresh, rescan }),
    [capability, connection, generation, connected, refresh, rescan],
  );
}
