// @vitest-environment jsdom
import type { DesktopPreviewBridge, DesktopPreviewPointerEvent } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettingsHydrated: () => true }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/previewStateStore", () => ({ useActivePreviewSessions: () => ({}) }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => undefined }));
vi.mock("./browserDefaults", () => ({ useBrowserDefaults: () => ({}) }));
vi.mock("./HostedBrowserWebview", () => ({ HostedBrowserWebview: () => null }));
vi.mock("./openFileInPreview", () => ({ openUrlInPreview: vi.fn() }));
vi.mock("./previewRuntime", () => ({ rendersServerTabNatively: () => false }));

import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { useBrowserPointerStore } from "./browserPointerStore";

afterEach(() => {
  useBrowserPointerStore.setState({ byTabId: {} });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("mounts in an older desktop shell and preserves pointer events without new-tab support", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  let pointerListener: ((event: DesktopPreviewPointerEvent) => void) | undefined;
  // The older preload has pointer events but no onOpenLink capability.
  const preview = {
    setAnnotationTheme: async () => undefined,
    onPointerEvent: (listener) => {
      pointerListener = listener;
      return () => {
        pointerListener = undefined;
      };
    },
  } satisfies Pick<DesktopPreviewBridge, "setAnnotationTheme" | "onPointerEvent">;
  vi.stubGlobal("desktopBridge", { preview });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ElectronBrowserHost />));
    const pointer: DesktopPreviewPointerEvent = {
      tabId: "legacy-tab",
      phase: "move",
      x: 20,
      y: 30,
      sequence: 1,
      createdAt: "2026-10-09T00:00:00.000Z",
    };
    expect(pointerListener).toBeDefined();
    pointerListener?.(pointer);
    expect(useBrowserPointerStore.getState().byTabId["legacy-tab"]).toEqual(pointer);
  } finally {
    await act(async () => root.unmount());
  }
  expect(pointerListener).toBeUndefined();
});
