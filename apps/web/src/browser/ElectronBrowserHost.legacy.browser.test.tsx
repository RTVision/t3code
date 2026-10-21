import type { DesktopPreviewBridge, DesktopPreviewPointerEvent } from "@t3tools/contracts";
import { render, stubGlobal } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettingsHydrated: () => true }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/previewStateStore", () => ({
  useActivePreviewSessions: () => ({}),
  pinPreviewDesktopProfile: vi.fn(),
}));
vi.mock("~/components/preview/usePreviewSession", () => ({
  useDesktopHostedPreviewSessions: vi.fn(),
}));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => undefined }));
vi.mock("./browserDefaults", () => ({ useBrowserDefaults: () => ({}) }));
vi.mock("./HostedBrowserWebview", () => ({ HostedBrowserWebview: () => null }));
vi.mock("./openFileInPreview", () => ({ openUrlInPreview: vi.fn() }));
vi.mock("./previewRuntime", () => ({ rendersServerTabNatively: () => false }));

import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { useBrowserPointerStore } from "./browserPointerStore";

it("mounts in an older desktop shell and preserves pointer events without new-tab support", async () => {
  using _frames = stubGlobal("requestAnimationFrame", () => 0);
  using _cancelFrames = stubGlobal("cancelAnimationFrame", () => undefined);
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
  using _bridge = stubGlobal("desktopBridge", { preview });
  using _pointerState = {
    [Symbol.dispose]() {
      useBrowserPointerStore.setState({ byTabId: {} });
    },
  };
  // The desktop bridge host does not use router state.
  await using screen = await render(<ElectronBrowserHost />, { router: false });
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
  await screen.unmount();
  expect(pointerListener).toBeUndefined();
});
