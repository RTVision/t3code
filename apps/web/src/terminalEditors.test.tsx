import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type TerminalEditorCapability } from "@t3tools/contracts";
import { invalidateTerminalEditors, useTerminalEditor } from "./terminalEditors";

const state = vi.hoisted(() => ({ generation: 1 }));
vi.mock("./connection/catalog", () => ({ environmentCatalog: { stateAtom: () => null } }));
vi.mock("./state/query", () => ({ useEnvironmentQuery: () => ({ data: state }) }));
vi.mock("./state/presentation", () => {
  const presentation = {
    entry: { target: { _tag: "PrimaryConnectionTarget" } },
    connection: { phase: "connected" },
  };
  return { useEnvironmentPresentation: () => ({ presentation }) };
});
const environmentId = EnvironmentId.make("terminal-test");
const unavailable: TerminalEditorCapability = {
  state: "unavailable",
  reason: "missing-neovim",
  message: "Missing Neovim",
  preferenceKey: "primary",
  routeGeneration: "route-1",
  terminals: [],
  selectedTerminal: null,
  executableOverride: null,
};
let root: Root;
let current: ReturnType<typeof useTerminalEditor>;
let commits: number;
const bridge = vi.fn(async () => unavailable);
function Consumer() {
  const terminal = useTerminalEditor(environmentId);
  useLayoutEffect(() => {
    current = terminal;
    commits++;
  });
  return null;
}
async function renderConsumers(count: number) {
  await act(() => root.render(Array.from({ length: count }, (_, key) => <Consumer key={key} />)));
}
beforeEach(() => {
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: EventTarget,
    desktopBridge: { probeTerminalEditor: bridge },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.generation = 1;
  commits = 0;
  bridge.mockReset().mockResolvedValue(unavailable);
  invalidateTerminalEditors();
  root = createRoot(container as unknown as HTMLElement);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("mounting and scrolling consumers never probes, even after a negative cache expires", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  await renderConsumers(10);
  expect(bridge).not.toHaveBeenCalled();
  expect(commits).toBe(10);
  await act(async () => {
    await Promise.all([current.refresh(), current.refresh()]);
  });
  expect(bridge).toHaveBeenCalledTimes(1);
  expect(current.capability).toEqual(unavailable);
  now = 5_001;
  await renderConsumers(20);
  expect(bridge).toHaveBeenCalledTimes(1);
  await act(async () => {
    await current.refresh();
  });
  expect(bridge).toHaveBeenCalledTimes(2);
});
it("rescan replaces the shared result and reconnect does not reuse old route capabilities", async () => {
  await renderConsumers(2);
  await act(async () => {
    await current.refresh();
  });
  const available = {
    ...unavailable,
    state: "available" as const,
    message: "Ready",
    routeGeneration: "route-2",
  };
  bridge.mockResolvedValueOnce(available);
  await act(async () => {
    await current.rescan();
  });
  expect(bridge).toHaveBeenCalledTimes(2);
  expect(current.capability).toEqual(available);
  state.generation = 2;
  await renderConsumers(2);
  expect(current.capability.state).toBe("checking");
  expect(bridge).toHaveBeenCalledTimes(2);
});
it("browser consumers immediately expose the desktop requirement without an async mount update", async () => {
  delete window.desktopBridge;
  await renderConsumers(10);
  expect(commits).toBe(10);
  expect(current.capability.reason).toBe("desktop-required");
  expect(bridge).not.toHaveBeenCalled();
});
