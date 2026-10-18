import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canOperate: false,
  canWriteSettings: true,
  connected: true,
  openEditor: vi.fn(),
  editorPermission: null as Atom.Writable<boolean> | null,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useLocation: (() => "") as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: () => {
    const environment = {
      environmentId: "primary-settings",
      serverConfig: {
        keybindings: [],
        keybindingsConfigPath: "/fixture/keybindings.json",
        availableEditors: ["vscode"],
      },
    };
    return (
      state.connected
        ? { environment, connectedEnvironments: [environment] }
        : { environment: null, connectedEnvironments: [] }
    ) as never;
  },
}));
vi.mock(import("../../state/session"), async (original) => {
  const hasScope = (environmentId: EnvironmentId | null, scope: string) =>
    environmentId === "primary-settings" &&
    (scope === "orchestration:operate"
      ? state.canOperate
      : scope === "settings:write" && state.canWriteSettings);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
    useEnvironmentsWithScope: (() =>
      new Set(state.canWriteSettings ? ["primary-settings"] : [])) as never,
  };
});
vi.mock(import("../../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    shellEnvironment: {
      ...actual.shellEnvironment,
      openInEditor: {
        ...actual.shellEnvironment.openInEditor,
        permissionAtom: () => state.editorPermission!,
      },
    },
  };
});
vi.mock(import("../../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.openEditor) as never,
}));

import { KeybindingsSettingsPanel } from "./KeybindingsSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";

let root: Root;
let container: HTMLDivElement;

const render = () =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <KeybindingsSettingsPanel />
      </RegistryContext.Provider>,
    ),
  );
const setOperate = (allowed: boolean) => {
  state.canOperate = allowed;
  appAtomRegistry.set(state.editorPermission!, allowed);
};
const openButton = () => {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Open keybindings.json"]',
  );
  expect(button).not.toBeNull();
  return button!;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.editorPermission = Atom.make(false);
  state.canOperate = false;
  localStorage.setItem("t3code:last-editor", JSON.stringify("vscode"));
  state.canWriteSettings = true;
  state.connected = true;
  state.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("KeybindingsSettings editor permission", () => {
  it("rejects editor launches when settings writes are the only write grant", async () => {
    await render();
    expect(openButton().disabled).toBe(true);
    await act(async () => openButton().click());
    expect(state.openEditor).not.toHaveBeenCalled();
  });

  it("opens the primary environment's file after operate is granted without settings writes", async () => {
    state.canWriteSettings = false;
    await render();
    await act(async () => setOperate(true));
    await render();
    expect(openButton().disabled).toBe(false);
    await act(async () => openButton().click());

    expect(state.openEditor).toHaveBeenCalledWith({
      environmentId: "primary-settings",
      input: { cwd: "/fixture/keybindings.json", editor: "vscode" },
    });
  });

  it("rejects a queued editor launch after operate is revoked", async () => {
    await render();
    await act(async () => setOperate(true));
    const button = openButton();
    expect(button.disabled).toBe(false);
    // The click lands before React renders the revoked grant.
    await act(async () => {
      setOperate(false);
      button.click();
    });

    expect(state.openEditor).not.toHaveBeenCalled();
    await render();
    expect(openButton().disabled).toBe(true);
  });
});

describe("KeybindingsSettings write notice", () => {
  it("asks for a connected environment when none is connected", async () => {
    state.connected = false;
    await render();
    expect(container.textContent).toContain("Connect an environment to change keybindings.");
  });

  it("names the permission when the connection cannot write settings", async () => {
    state.canWriteSettings = false;
    await render();
    expect(container.textContent).toContain(
      "This connection can view keybindings but cannot change them.",
    );
  });
});
