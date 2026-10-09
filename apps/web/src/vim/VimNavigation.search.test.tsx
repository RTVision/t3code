// @vitest-environment jsdom
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { VimNavigation } from "./VimNavigation";
import { getVimMode, setVimMode } from "./runtime";
import { ThreadFindBar } from "../components/chat/ThreadFindBar";

const vimSettings = vi.hoisted(() => ({ enabled: true }));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select({ ...DEFAULT_CLIENT_SETTINGS, vim: { ...DEFAULT_CLIENT_SETTINGS.vim, ...vimSettings } }),
  getClientSettings: () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    vim: { ...DEFAULT_CLIENT_SETTINGS.vim, ...vimSettings },
  }),
}));
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vimSettings.enabled = true;
});

function ThreadFindHarness() {
  const [open, setOpen] = useState(true);
  const composerRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    composerRef.current?.focus();
  }, []);
  useEffect(() => {
    // ChatView's window fallback runs after Vim's layout-effect listener.
    const dismissFind = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      )
        return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", dismissFind);
    return () => window.removeEventListener("keydown", dismissFind);
  }, [close]);
  return (
    <>
      <VimNavigation isOnSettings={false} />
      <div data-vim-pane="chat" tabIndex={-1}>
        <ThreadFindBar
          open={open}
          query="match"
          matchCount={1}
          status={null}
          activeIndex={0}
          focusRequestId={0}
          onRetry={() => {}}
          onQueryChange={() => {}}
          onNext={() => {}}
          onPrevious={() => {}}
          onClose={close}
        />
        <input ref={composerRef} data-testid="composer-editor" aria-label="Composer" />
      </div>
    </>
  );
}

it.each([true, false])(
  "closes thread Find with one Escape and returns to the composer, Vim=%s",
  async (enabled) => {
    vimSettings.enabled = enabled;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ThreadFindHarness />));
      const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
      expect(document.activeElement).toBe(input);
      for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
        const escape = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
          ...composition,
        });
        await act(async () => input.dispatchEvent(escape));
        expect(escape.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(input);
        expect(container.querySelector('input[type="search"]')).toBe(input);
      }
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      await act(async () => input.dispatchEvent(escape));
      expect(escape.defaultPrevented).toBe(true);
      expect(container.querySelector('input[type="search"]')).toBeNull();
      expect(document.activeElement).toBe(container.querySelector('[aria-label="Composer"]'));
      if (enabled) expect(getVimMode()).toBe("insert");
    } finally {
      await act(async () => root.unmount());
    }
  },
);
it("leaves IME confirmation and search typing to the shadow input, then confirms a plain Enter", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const pane = document.createElement("div");
  pane.dataset.vimPane = "diff";
  pane.tabIndex = -1;
  const host = document.createElement("div");
  host.setAttribute("data-diffs-search", "");
  const input = document.createElement("input");
  host.attachShadow({ mode: "open" }).append(input);
  pane.append(host);
  document.body.append(container, pane);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<VimNavigation isOnSettings={false} />));
    await act(async () => {
      input.focus();
      setVimMode("insert");
    });
    const ime = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 229,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    await act(async () => input.dispatchEvent(ime));
    expect(ime.defaultPrevented).toBe(false);
    expect(getVimMode()).toBe("insert");
    expect(host.shadowRoot!.activeElement).toBe(input);
    const typing = new KeyboardEvent("keydown", {
      key: "n",
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    await act(async () => input.dispatchEvent(typing));
    expect(typing.defaultPrevented).toBe(false);
    const confirm = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    await act(async () => input.dispatchEvent(confirm));
    expect(confirm.defaultPrevented).toBe(true);
    expect(getVimMode()).toBe("normal");
    expect(document.activeElement).toBe(pane);
  } finally {
    await act(async () => root.unmount());
  }
});
