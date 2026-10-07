import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { assert, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  terminalAllowed: new Set<string>(),
  choice: null as { kind: "gui"; editor: "cursor" } | { kind: "terminal"; editor: "neovim" } | null,
  run: vi.fn(),
  getPreference: vi.fn(),
  setPreference: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (compute: () => unknown) => compute(),
  useEffect: vi.fn(),
}));
vi.mock("./editorPreferenceStorage", () => ({
  useEditorPreference: (key: string, fallback: unknown) => [
    key === "t3code:editor-choice:v1" ? state.choice : fallback,
    state.setPreference,
  ],
}));
vi.mock("./terminalEditors", () => ({
  useTerminalEditor: () => ({
    capability: { preferenceKey: "", state: "unavailable" },
    connected: false,
    refresh: vi.fn(),
  }),
  invalidateTerminalEditors: vi.fn(),
}));
vi.mock("./remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
  useRemoteCapableEditors: () => [],
  openRemoteEditorUrl: vi.fn(),
}));
vi.mock("./state/shell", () => ({ shellEnvironment: { openInEditor: "openInEditor" } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("./state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope
      ? state.allowed.has(environmentId)
      : scope === AuthTerminalOperateScope && state.terminalAllowed.has(environmentId),
}));
vi.mock("./hooks/useLocalStorage", () => ({
  getLocalStorageItem: state.getPreference,
  setLocalStorageItem: state.setPreference,
  useLocalStorage: vi.fn(),
}));

import { useOpenInPreferredEditor } from "./editorPreferences";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");

beforeEach(() => {
  state.allowed.clear();
  state.terminalAllowed.clear();
  state.choice = null;
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.getPreference.mockReset().mockReturnValue(null);
  state.setPreference.mockReset();
});

it("does not use another environment's grant or change preferences when denied", async () => {
  state.allowed.add(primary);
  const open = useOpenInPreferredEditor(secondary, ["vscode"]);
  const result = await open("/work/readme.md");
  assert(result._tag === "Failure");
  const error = Cause.squash<unknown>(result.cause);
  expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
  expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
  expect(state.run).not.toHaveBeenCalled();
  expect(state.getPreference).not.toHaveBeenCalled();
  expect(state.setPreference).not.toHaveBeenCalled();
});

it("checks revocation and regrant when a retained editor callback is invoked", async () => {
  state.allowed.add(secondary);
  const open = useOpenInPreferredEditor(secondary, ["vscode"]);
  state.allowed.delete(secondary);
  expect((await open("/work/readme.md:5"))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();

  state.allowed.add(secondary);
  expect(await open("/work/readme.md:5")).toMatchObject({ _tag: "Success", value: "vscode" });
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId: secondary,
    input: { cwd: "/work/readme.md:5", editor: "vscode" },
  });
  expect(state.setPreference).not.toHaveBeenCalled();
});

it("keeps the stored available editor for an authorized launch", async () => {
  state.allowed.add(secondary);
  state.choice = { kind: "gui", editor: "cursor" };
  const open = useOpenInPreferredEditor(secondary, ["vscode", "cursor"]);
  expect(await open("/work")).toMatchObject({ _tag: "Success", value: "cursor" });
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId: secondary,
    input: { cwd: "/work", editor: "cursor" },
  });
  expect(state.setPreference).not.toHaveBeenCalled();
});

it("returns the existing failures for a missing environment or editor", async () => {
  state.allowed.add(secondary);
  expect((await useOpenInPreferredEditor(null, ["vscode"])("/work"))._tag).toBe("Failure");
  expect((await useOpenInPreferredEditor(secondary, [])("/work"))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();
});

it("requires terminal permission for a saved Neovim choice before invoking desktop IPC", async () => {
  state.allowed.add(secondary);
  state.choice = { kind: "terminal", editor: "neovim" };
  const result = await useOpenInPreferredEditor(secondary, ["vscode"])("/work/readme.md");
  assert(result._tag === "Failure");
  expect(Cause.squash<unknown>(result.cause)).toMatchObject({
    requiredScope: AuthTerminalOperateScope,
  });
  expect(state.run).not.toHaveBeenCalled();
});
