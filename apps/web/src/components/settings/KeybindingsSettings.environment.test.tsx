import type { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  canOperate: false,
  canOperateTerminal: false,
  editorRoute: "local-gui" as "local-gui" | "remote-gui" | "terminal",
  canWriteSettings: true,
  canReadDiagnostics: true,
  openEditor: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "config-path" ? "/fixture/keybindings.json" : []),
}));

vi.mock("@tanstack/react-router", () => ({ useLocation: () => "" }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../state/server", () => ({
  primaryServerKeybindingsAtom: "keybindings",
  primaryServerKeybindingsConfigPathAtom: "config-path",
  primaryServerAvailableEditorsAtom: "editors",
  serverEnvironment: {
    traceDiagnostics: vi.fn(),
    processDiagnostics: vi.fn(),
    processResourceHistory: vi.fn(),
    signalProcess: vi.fn(),
    upsertKeybinding: state.upsert,
    removeKeybinding: state.remove,
  },
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "primary-settings" }),
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => {
    const environment = {
      environmentId: "primary-settings",
      connection: { phase: "connected" },
      serverConfig: {
        keybindings: [],
        keybindingsConfigPath: "/fixture/keybindings.json",
        availableEditors: [],
        observability: { logsDirectoryPath: "/fixture/logs" },
      },
    };
    return { environment, connectedEnvironments: [environment] };
  },
}));

vi.mock("../../state/session", () => {
  const hasScope = (environmentId: EnvironmentId | null, scope: string) =>
    environmentId === "primary-settings" &&
    (scope === "orchestration:operate"
      ? state.canOperate
      : scope === "settings:write" && state.canWriteSettings);
  return {
    environmentSession: { sessionStateAtom: () => "session" },
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    useEnvironmentsWithScope: () => new Set(state.canWriteSettings ? ["primary-settings"] : []),
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));

vi.mock("../../editorPreferences", async () => {
  const Cause = await import("effect/Cause");
  const canOpen = () =>
    state.editorRoute === "remote-gui" ||
    (state.editorRoute === "terminal" ? state.canOperateTerminal : state.canOperate);
  const open = (environmentId: EnvironmentId) => (path: string) => {
    if (!canOpen()) return Promise.resolve({ _tag: "Failure", cause: Cause.interrupt() });
    return state.openEditor({ environmentId, path });
  };
  return {
    useOpenInPreferredEditor: open,
    useEditorDispatch: (environmentId: EnvironmentId) => ({
      open: open(environmentId),
      canOpen: canOpen(),
    }),
  };
});

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === "session"
        ? { authenticated: true, scopes: state.canReadDiagnostics ? ["diagnostics:read"] : [] }
        : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
import { DiagnosticsSettingsPanel } from "./DiagnosticsSettings";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

function renderPanel() {
  hooks.beginRender();
  return KeybindingsSettingsPanel();
}

function openButton(panel: unknown) {
  const button = visitElements(
    panel,
    (element) => element.props["aria-label"] === "Open keybindings.json",
  );
  if (!button) throw new Error("Missing Open keybindings.json action.");
  return button;
}

describe("KeybindingsSettings editor permission", () => {
  beforeEach(() => {
    hooks.reset();
    state.canOperate = false;
    state.canOperateTerminal = false;
    state.editorRoute = "local-gui";
    state.canWriteSettings = true;
    state.openEditor.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    state.upsert.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    state.remove.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  });

  it("rejects editor launches when settings writes are the only write grant", () => {
    const button = openButton(renderPanel());
    (button.props.onClick as () => void)();

    expect(state.openEditor).not.toHaveBeenCalled();
    expect(button.props.disabled).toBe(true);
  });

  it.each(["remote-gui", "terminal"] as const)(
    "opens the file through %s without orchestration permission",
    (route) => {
      state.editorRoute = route;
      state.canOperateTerminal = true;
      const button = openButton(renderPanel());
      expect(button.props.disabled).toBe(false);
      (button.props.onClick as () => void)();
      expect(state.openEditor).toHaveBeenCalledWith({
        environmentId: "primary-settings",
        path: "/fixture/keybindings.json",
      });
      state.editorRoute = "local-gui";
      expect(openButton(renderPanel()).props.disabled).toBe(true);
    },
  );

  it("opens the primary environment's file after operate is granted without settings writes", () => {
    state.canWriteSettings = false;
    renderPanel();
    state.canOperate = true;
    const button = openButton(renderPanel());
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();

    expect(state.openEditor).toHaveBeenCalledWith({
      environmentId: "primary-settings",
      path: "/fixture/keybindings.json",
    });
  });

  it("rejects a queued editor launch after operate is revoked", () => {
    state.canOperate = true;
    const open = openButton(renderPanel()).props.onClick as () => void;
    state.canOperate = false;
    open();

    expect(state.openEditor).not.toHaveBeenCalled();
    expect(openButton(renderPanel()).props.disabled).toBe(true);
  });
});

it.each(["remote-gui", "terminal"] as const)(
  "opens diagnostics logs through %s without orchestration permission",
  async (route) => {
    hooks.reset();
    state.canOperate = false;
    state.canOperateTerminal = true;
    state.editorRoute = route;
    state.openEditor.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    hooks.beginRender();
    const button = visitElements(
      DiagnosticsSettingsPanel(),
      (el) => el.props["aria-label"] === "Open logs folder",
    );
    if (!button) throw new Error("Missing logs folder action");
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    await Promise.resolve();
    expect(state.openEditor).toHaveBeenCalledWith({
      environmentId: "primary-settings",
      path: { kind: "directory", path: "/fixture/logs" },
    });
  },
);

it("keeps logs hidden when diagnostics access is denied", () => {
  hooks.reset();
  state.canReadDiagnostics = false;
  state.editorRoute = "remote-gui";
  hooks.beginRender();
  expect(
    visitElements(
      DiagnosticsSettingsPanel(),
      (el) => el.props["aria-label"] === "Open logs folder",
    ),
  ).toBeNull();
  state.canReadDiagnostics = true;
});
