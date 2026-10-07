import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  type EditorChoice,
  EnvironmentId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { nextTerminalAttachSeedState } from "@t3tools/client-runtime/state/terminal";
import { AsyncResult } from "effect/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  GhosttyTerminalSurface,
  GhosttyTerminalSurfaceOptions,
} from "~/terminal/ghostty/surface";

const state = vi.hoisted(() => ({
  allowed: true,
  hostAllowed: true,
  choice: null as EditorChoice | null,
  remote: {
    state: { mode: "local-exec" },
    isResolved: true,
  } as import("../remoteOpen").RemoteOpenResolution,
  openRemoteUrl: vi.fn(),
  openGui: vi.fn(),
  openTerminalEditor: vi.fn(),
  refreshLinkActivation: vi.fn(),
  listeners: new Set<() => void>(),
  resize: vi.fn(),
  otherCommand: vi.fn(),
  createSurface:
    vi.fn<
      (
        mount: HTMLElement,
        options: GhosttyTerminalSurfaceOptions,
      ) => Promise<GhosttyTerminalSurface>
    >(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ availableEditors: ["vscode"] }) }));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
}));
vi.mock("../editorPreferenceStorage", () => ({
  useEditorPreference: (key: string, fallback: unknown) => [
    key === "t3code:editor-choice:v1" ? state.choice : fallback,
    state.otherCommand,
  ],
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => state.remote,
  useRemoteCapableEditors: () => ["vscode"],
  openRemoteEditorUrl: state.openRemoteUrl,
}));
vi.mock("../terminalEditors", () => ({
  useTerminalEditor: () => ({
    connected: true,
    connection: { environmentId: "secondary-terminal" },
    generation: 1,
    capability: { preferenceKey: "", state: "available", routeGeneration: 1 },
    refresh: async () => ({ state: "available", routeGeneration: 1 }),
  }),
  invalidateTerminalEditors: vi.fn(),
}));
vi.mock("../state/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/shell")>()),
  shellEnvironment: { openInEditor: "openInEditor" },
}));
vi.mock("~/lib/selectionActions", () => ({
  observeSelectionActions: () => ({ dispose: vi.fn(), cancel: vi.fn(), pending: false }),
  resolveSelectionActionPosition: vi.fn(),
}));
vi.mock("../localApi", () => ({ readLocalApi: () => null }));
vi.mock("../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config" },
}));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: "open" } }));
vi.mock("../state/terminal", () => ({ terminalEnvironment: { resize: "resize", write: "write" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "resize"
      ? state.resize
      : command === "openInEditor"
        ? state.openGui
        : state.otherCommand,
}));
vi.mock("../state/terminalSessions", () => ({
  useAttachedTerminalSession: () => session,
}));
vi.mock("~/terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: { create: state.createSurface },
}));
vi.mock("../state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (id !== threadRef.environmentId ||
      (scope === AuthTerminalOperateScope
        ? state.allowed
        : scope === AuthOrchestrationOperateScope
          ? state.hostAllowed
          : true));
  return {
    readEnvironmentScope,
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
  };
});

import { TerminalViewport } from "./ThreadTerminalDrawer";

const threadRef = {
  environmentId: EnvironmentId.make("secondary-terminal"),
  threadId: ThreadId.make("thread"),
};
const session = { ...nextTerminalAttachSeedState(), status: "running" as const, version: 1 };
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  state.allowed = true;
  state.hostAllowed = true;
  state.choice = null;
  state.remote = { state: { mode: "local-exec" }, isResolved: true };
  state.openRemoteUrl.mockReset().mockResolvedValue(true);
  state.openGui.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openTerminalEditor.mockReset().mockResolvedValue({ status: "opened" });
  state.refreshLinkActivation.mockReset();
  state.listeners.clear();
  state.resize.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.otherCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  // A surface can report its initial grid while asynchronous WASM setup is
  // pending. Keep that unrelated setup pending while exercising its callback.
  state.createSurface.mockReset().mockReturnValue(new Promise(() => undefined));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", {
    body: {},
    documentElement: { classList: { contains: () => false } },
    querySelector: () => null,
    createElement: () => ({ getContext: () => null }),
  });
  vi.stubGlobal("window", {
    desktopBridge: { openTerminalEditor: state.openTerminalEditor },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
  });
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("getComputedStyle", () => ({
    colorScheme: "light",
    backgroundColor: "",
    color: "",
    getPropertyValue: () => "",
  }));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function viewport() {
  return (
    <TerminalViewport
      advancedTypography={false}
      threadRef={threadRef}
      threadId={threadRef.threadId}
      terminalId="terminal-1"
      terminalLabel="Terminal 1"
      cwd="/repo"
      onSessionExited={state.otherCommand}
      focusRequestId={0}
      autoFocus={false}
      visible={true}
      resizeEpoch={0}
      drawerHeight={200}
      keybindings={[]}
    />
  );
}

async function mountViewport() {
  await act(async () => {
    renderer = create(viewport(), {
      createNodeMock: () => ({ closest: () => null, contains: () => false }),
    });
  });
}

async function mountLinkSurface() {
  state.createSurface.mockResolvedValue({
    setVisible: vi.fn(),
    setTheme: vi.fn(),
    input: { readOnly: false },
    dispose: vi.fn(),
    write: vi.fn(),
    resendSize: vi.fn(),
    fit: vi.fn(),
    isAtBottom: () => true,
    refreshLinkActivation: state.refreshLinkActivation,
  } as unknown as GhosttyTerminalSurface);
  await mountViewport();
  return state.createSurface.mock.calls[0]![1];
}

async function refreshViewport() {
  await act(async () => renderer?.update(viewport()));
}

it("rechecks the target terminal grant when a retained surface callback reports a resize", async () => {
  await mountViewport();
  expect(state.createSurface).toHaveBeenCalledOnce();
  const onResize = state.createSurface.mock.calls[0]![1].onResize;
  if (!onResize) throw new Error("The terminal did not register its resize callback.");

  onResize(80, 24);
  expect(state.resize).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, terminalId: "terminal-1", cols: 80, rows: 24 },
  });

  // The connection updates before React commits its external-store update.
  // Other environments retain access; only this terminal's target is revoked.
  state.allowed = false;
  onResize(120, 40);
  expect(state.resize).toHaveBeenCalledTimes(1);

  state.allowed = true;
  onResize(100, 30);
  expect(state.resize).toHaveBeenCalledTimes(2);
  expect(state.resize).toHaveBeenLastCalledWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, terminalId: "terminal-1", cols: 100, rows: 30 },
  });
});

it("opens remote GUI path links without either host execution grant", async () => {
  state.allowed = false;
  state.hostAllowed = false;
  state.remote = {
    state: { mode: "remote-links", host: { kind: "ssh-alias", host: "devbox" } },
    isResolved: true,
  };
  const options = await mountLinkSurface();
  expect(options.canActivateLink?.("src/app.ts:12")).toBe(true);
  await act(async () => options.onLinkActivate("src/app.ts:12", {} as MouseEvent));
  expect(state.openRemoteUrl).toHaveBeenCalledExactlyOnceWith(
    "vscode://vscode-remote/ssh-remote+devbox/repo/src/app.ts%3A12",
  );
  expect(state.openGui).not.toHaveBeenCalled();
  expect(state.openTerminalEditor).not.toHaveBeenCalled();
});

it("opens a saved terminal Neovim path with only terminal permission", async () => {
  state.hostAllowed = false;
  state.choice = { kind: "terminal", editor: "neovim" };
  const options = await mountLinkSurface();
  expect(options.canActivateLink?.("src/app.ts:12")).toBe(true);
  await act(async () => options.onLinkActivate("src/app.ts:12", {} as MouseEvent));
  expect(state.openTerminalEditor).toHaveBeenCalledOnce();
  expect(state.openTerminalEditor).toHaveBeenCalledWith(
    expect.objectContaining({
      editor: "neovim",
      workspacePath: "/repo",
      target: expect.objectContaining({ kind: "file", path: "/repo/src/app.ts", line: 12 }),
    }),
  );
  expect(state.openGui).not.toHaveBeenCalled();
});

it("keeps denied local GUI path links inactive while allowing browser URLs", async () => {
  state.hostAllowed = false;
  const options = await mountLinkSurface();
  expect(options.canActivateLink?.("src/app.ts:12")).toBe(false);
  expect(options.canActivateLink?.("https://example.com")).toBe(true);
  await act(async () => options.onLinkActivate("src/app.ts:12", {} as MouseEvent));
  expect(state.openGui).not.toHaveBeenCalled();
});

it("rechecks a revoked terminal grant before click and resumes after regrant", async () => {
  state.choice = { kind: "terminal", editor: "neovim" };
  const options = await mountLinkSurface();
  expect(options.canActivateLink?.("src/app.ts:12")).toBe(true);
  // The permission store changes before React publishes a new snapshot.
  state.allowed = false;
  await act(async () => options.onLinkActivate("src/app.ts:12", {} as MouseEvent));
  expect(state.openTerminalEditor).not.toHaveBeenCalled();
  await refreshViewport();
  expect(state.refreshLinkActivation).toHaveBeenCalledOnce();
  expect(options.canActivateLink?.("src/app.ts:12")).toBe(false);
  state.allowed = true;
  await refreshViewport();
  expect(state.refreshLinkActivation).toHaveBeenCalledTimes(2);
  await act(async () => options.onLinkActivate("src/app.ts:12", {} as MouseEvent));
  expect(state.openTerminalEditor).toHaveBeenCalledOnce();
});

it("refreshes stationary hover when editor choice or remote routing changes", async () => {
  state.allowed = false;
  state.hostAllowed = false;
  state.choice = { kind: "terminal", editor: "neovim" };
  state.remote = {
    state: { mode: "remote-links", host: { kind: "ssh-alias", host: "devbox" } },
    isResolved: true,
  };
  const options = await mountLinkSurface();
  expect(options.canActivateLink?.("src/app.ts:12")).toBe(false);
  state.choice = { kind: "gui", editor: "vscode" };
  await refreshViewport();
  expect(state.refreshLinkActivation).toHaveBeenCalledOnce();
  expect(options.canActivateLink?.("src/app.ts:12")).toBe(true);
  state.remote = { state: { mode: "remote-unavailable" }, isResolved: true };
  await refreshViewport();
  expect(state.refreshLinkActivation).toHaveBeenCalledTimes(2);
  expect(options.canActivateLink?.("src/app.ts:12")).toBe(false);
});

it("rechecks local GUI revocation before activation and refreshes on regrant", async () => {
  const options = await mountLinkSurface();
  expect(options.canActivateLink?.("src/app.ts:12")).toBe(true);
  state.hostAllowed = false;
  await act(async () => options.onLinkActivate("src/app.ts:12", {} as MouseEvent));
  expect(state.openGui).not.toHaveBeenCalled();
  await refreshViewport();
  expect(state.refreshLinkActivation).toHaveBeenCalledOnce();
  state.hostAllowed = true;
  await refreshViewport();
  expect(state.refreshLinkActivation).toHaveBeenCalledTimes(2);
  await act(async () => options.onLinkActivate("src/app.ts:12", {} as MouseEvent));
  expect(state.openGui).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { cwd: "/repo/src/app.ts:12", editor: "vscode" },
  });
});

it("waits for a resolved GUI route before enabling path links", async () => {
  state.remote = { state: { mode: "local-exec" }, isResolved: false };
  const options = await mountLinkSurface();
  expect(options.canActivateLink?.("src/app.ts:12")).toBe(false);
  await act(async () => options.onLinkActivate("src/app.ts:12", {} as MouseEvent));
  expect(state.openGui).not.toHaveBeenCalled();
  state.remote = { state: { mode: "local-exec" }, isResolved: true };
  await refreshViewport();
  expect(state.refreshLinkActivation).toHaveBeenCalledOnce();
  expect(options.canActivateLink?.("src/app.ts:12")).toBe(true);
});
