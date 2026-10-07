import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type EditorChoice,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  run: vi.fn(),
  toast: vi.fn(),
  choice: { kind: "gui", editor: "vscode" } as EditorChoice,
  remote: { mode: "local-exec" } as
    | { mode: "local-exec" }
    | { mode: "remote-links"; host: { kind: "ssh-alias"; host: string } }
    | { mode: "remote-unavailable" },
  bridge: vi.fn(),
  remoteOpen: vi.fn(),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("@t3tools/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
  }),
}));
vi.mock("../rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
);
const openEditorCommand = createEnvironmentRpcCommand(runtime, {
  label: "test.open-editor",
  tag: WS_METHODS.shellOpenInEditor,
});
vi.mock("../state/shell", () => ({
  shellEnvironment: {
    get openInEditor() {
      return openEditorCommand;
    },
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("../terminalEditors", () => ({
  useTerminalEditor: () => ({
    capability: { preferenceKey: "", state: "available" },
    connected: true,
    connection: { kind: "primary" },
    generation: 1,
    refresh: async () => ({ state: "available", routeGeneration: 1 }),
  }),
  invalidateTerminalEditors: vi.fn(),
}));
vi.mock("../editorPreferenceStorage", () => ({
  useEditorPreference: (key: string, fallback: unknown) => [
    key === "t3code:editor-choice:v1" ? state.choice : fallback,
    vi.fn(),
  ],
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: state.remote, isResolved: true }),
  useRemoteCapableEditors: () => ["vscode"],
  openRemoteEditorUrl: (url: string) => state.remoteOpen(url),
}));
vi.mock("./ui/button", () => ({ Button: "button" }));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (value: unknown) => value,
}));

import { KeybindingsConfigWarning } from "./KeybindingsConfigWarning";

const environmentId = EnvironmentId.make("warning-environment");
let renderer: ReactTestRenderer | undefined;
const session = (scopes: readonly AuthEnvironmentScope[]): AuthSessionState => ({
  authenticated: true,
  scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.registry = AtomRegistry.make();
  state.sessions.set(
    environmentId,
    Atom.make<SessionResult>(AsyncResult.success(session([AuthOrchestrationOperateScope]))).pipe(
      Atom.keepAlive,
    ),
  );
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.toast.mockReset();
  state.choice = { kind: "gui", editor: "vscode" };
  state.remote = { mode: "local-exec" };
  state.bridge.mockReset().mockResolvedValue({ status: "opened" });
  state.remoteOpen.mockReset().mockResolvedValue(true);
  vi.stubGlobal("window", { desktopBridge: { openTerminalEditor: state.bridge } });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  state.sessions.clear();
  vi.unstubAllGlobals();
});

it("updates a visible warning on revocation and blocks its retained action until regrant", async () => {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={state.registry!}>
        <KeybindingsConfigWarning
          environmentId={environmentId}
          configPath="/t3/keybindings.json"
          availableEditors={["vscode"]}
          message="Invalid shortcut"
        />
      </RegistryContext.Provider>,
    );
  });
  const open = renderer!.root.findByType("button").props.onClick;
  expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  await act(async () => {
    state.registry!.set(state.sessions.get(environmentId)!, AsyncResult.success(session([])));
    await open();
  });
  expect(renderer!.root.findByType("button").props.disabled).toBe(true);
  expect(state.run).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Unable to open keybindings file",
    }),
  );

  await act(async () => {
    state.registry!.set(
      state.sessions.get(environmentId)!,
      AsyncResult.success(session([AuthOrchestrationOperateScope])),
    );
  });
  expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  await act(async () => open());
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { cwd: "/t3/keybindings.json", editor: "vscode" },
  });
});

it.each(["terminal", "remote-gui"] as const)(
  "permits the warning action when the selected %s route is authorized",
  async (route) => {
    state.choice =
      route === "terminal"
        ? { kind: "terminal", editor: "neovim" }
        : { kind: "gui", editor: "vscode" };
    state.remote =
      route === "terminal"
        ? { mode: "local-exec" }
        : { mode: "remote-links", host: { kind: "ssh-alias", host: "dev" } };
    state.registry!.set(
      state.sessions.get(environmentId)!,
      AsyncResult.success(session(route === "terminal" ? ["terminal:operate"] : [])),
    );
    await act(async () => {
      renderer = create(
        <RegistryContext.Provider value={state.registry!}>
          <KeybindingsConfigWarning
            environmentId={environmentId}
            configPath="/t3/keybindings.json"
            availableEditors={route === "terminal" ? [] : ["vscode"]}
            message="Invalid shortcut"
          />
        </RegistryContext.Provider>,
      );
    });
    const button = renderer!.root.findByType("button");
    // Invoke the same retained handler to prove the real dispatcher accepts this route.
    await act(async () => button.props.onClick());
    expect(route === "terminal" ? state.bridge : state.remoteOpen).toHaveBeenCalledOnce();
    expect(state.toast).not.toHaveBeenCalled();
    expect(button.props.disabled).toBe(false);
  },
);

it("refreshes warning availability when the selected editor route and live grant change", async () => {
  const warning = () => (
    <RegistryContext.Provider value={state.registry!}>
      <KeybindingsConfigWarning
        environmentId={environmentId}
        configPath="/t3/keybindings.json"
        availableEditors={["vscode"]}
        message="Invalid shortcut"
      />
    </RegistryContext.Provider>
  );
  const disabled = () => renderer!.root.findByType("button").props.disabled;
  await act(async () => {
    renderer = create(warning());
  });
  expect(disabled()).toBe(false);
  state.choice = { kind: "terminal", editor: "neovim" };
  await act(async () => renderer!.update(warning()));
  expect(disabled()).toBe(true);
  await act(async () =>
    state.registry!.set(
      state.sessions.get(environmentId)!,
      AsyncResult.success(session(["terminal:operate"])),
    ),
  );
  expect(disabled()).toBe(false);
  state.choice = { kind: "gui", editor: "vscode" };
  state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "dev" } };
  await act(async () => {
    state.registry!.set(state.sessions.get(environmentId)!, AsyncResult.success(session([])));
    renderer!.update(warning());
  });
  expect(disabled()).toBe(false);
  state.remote = { mode: "remote-unavailable" };
  await act(async () => renderer!.update(warning()));
  expect(disabled()).toBe(true);
  state.remote = { mode: "local-exec" };
  await act(async () => renderer!.update(warning()));
  expect(disabled()).toBe(true);
  await act(async () =>
    state.registry!.set(
      state.sessions.get(environmentId)!,
      AsyncResult.success(session([AuthOrchestrationOperateScope])),
    ),
  );
  expect(disabled()).toBe(false);
});
