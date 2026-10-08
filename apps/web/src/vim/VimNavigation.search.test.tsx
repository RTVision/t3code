// @vitest-environment jsdom
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { VimNavigation } from "./VimNavigation";
import { getVimMode, setVimMode } from "./runtime";

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select({ ...DEFAULT_CLIENT_SETTINGS, vim: { ...DEFAULT_CLIENT_SETTINGS.vim, enabled: true } }),
  getClientSettings: () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    vim: { ...DEFAULT_CLIENT_SETTINGS.vim, enabled: true },
  }),
}));
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
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
