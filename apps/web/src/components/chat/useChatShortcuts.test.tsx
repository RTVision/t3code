import { act } from "../../../test/act";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { dispatchAppCommand } from "../../vim/commandBus";
import { useChatShortcuts, type ChatShortcutsInput } from "./useChatShortcuts";
import type { ChatComposerHandle } from "./ChatComposer";

const state = vi.hoisted(() => ({ vim: true }));
vi.mock("../../vim/runtime", () => ({ vimEnabled: () => state.vim }));
vi.mock("../../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));
vi.mock("../../keybindings", () => ({ resolveChatShortcutCommand: () => null }));
vi.mock("../../lib/terminalCloseConfirm", () => ({ isTerminalCloseConfirmPending: () => false }));
vi.mock("../../lib/terminalCloseShortcut", () => ({
  preventRepeatedTerminalCloseShortcut: () => false,
  preventTerminalCloseShortcut: () => false,
}));
vi.mock("../../lib/terminalFocus", () => ({ getTerminalFocusOwner: () => null }));
vi.mock("./composerFocusRedirect", () => ({ shouldTypeToFocusComposer: () => true }));

let renderer: ReactTestRenderer | null = null;
function Surface({ input }: { input: ChatShortcutsInput }) {
  useChatShortcuts(input);
  return null;
}
function input(run: () => void): ChatShortcutsInput {
  return {
    enabled: true,
    keybindings: [] as ResolvedKeybindingsConfig,
    scriptKeybindings: [] as ResolvedKeybindingsConfig,
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    composerRef: {
      current: {
        insertTextAtEnd: vi.fn(() => true),
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: vi.fn(),
    commands: { "thread.stop": run },
    fallback: () => undefined,
  };
}
function key() {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: "x" });
  return event as KeyboardEvent;
}
beforeEach(() => {
  state.vim = true;

  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { activeElement: null });
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});
it("dispatches consumed Vim commands to the latest chat and unsubscribes on unmount", async () => {
  const first = vi.fn();
  const next = vi.fn();
  await act(() => {
    renderer = create(<Surface input={input(first)} />);
  });
  await act(() => {
    renderer!.update(<Surface input={input(next)} />);
  });
  const event = key();
  event.preventDefault();
  dispatchAppCommand("thread.stop", event);
  expect(first).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
  await act(() => renderer!.unmount());
  renderer = null;
  dispatchAppCommand("thread.stop", key());
  expect(next).toHaveBeenCalledOnce();
});
it("keeps printable Vim navigation out of the composer while ordinary typing still enters it", async () => {
  const options = input(vi.fn());
  await act(() => {
    renderer = create(<Surface input={options} />);
  });
  window.dispatchEvent(key());
  expect(options.composerRef.current?.insertTextAtEnd).not.toHaveBeenCalled();
  state.vim = false;
  window.dispatchEvent(key());
  expect(options.composerRef.current?.insertTextAtEnd).toHaveBeenCalledWith("x");
});
