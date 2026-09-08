import { useEffect, useSyncExternalStore } from "react";
import { getClientSettings } from "../hooks/useSettings";
import type { VimCommand, VimMode, VimScope } from "./bindings";

export interface VimAction {
  command: VimCommand;
  count: number;
  event: KeyboardEvent;
  scope: VimScope;
}
type Listener = (action: VimAction) => boolean | void;
const actions = new Set<Listener>();
const listeners = new Set<() => void>();
let mode: VimMode = "normal";
export function vimEnabled(): boolean {
  return getClientSettings().vim.enabled;
}
export function getVimMode(): VimMode {
  return mode;
}
export function setVimMode(next: VimMode): void {
  if (mode === next) return;
  mode = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useVimMode(): VimMode {
  return useSyncExternalStore(subscribe, getVimMode, () => "normal");
}
export function useVimAction(listener: Listener): void {
  useEffect(() => {
    actions.add(listener);
    return () => {
      actions.delete(listener);
    };
  }, [listener]);
}
export function dispatchVimAction(action: VimAction): boolean {
  for (const listener of actions) if (listener(action)) return true;
  return false;
}
export function vimPane(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>("[data-vim-pane]") ?? null;
}
export function vimScope(element: Element | null): VimScope {
  const pane = vimPane(element)?.dataset.vimPane;
  return pane === "chat" || pane === "terminal" || pane === "sidebar" || pane === "diff"
    ? pane
    : "other";
}
export function focusVimNormal(pane?: HTMLElement | null): void {
  setVimMode("normal");
  (pane ?? document.querySelector<HTMLElement>('[data-vim-pane="chat"]'))?.focus({
    preventScroll: true,
  });
}

let requestedPane: VimScope | null = null;
export function cancelVimPaneFocus(): void {
  requestedPane = null;
}
export function requestVimPaneFocus(scope: VimScope): void {
  requestedPane = scope;
}
export function claimVimPaneFocus(scope: VimScope, element: HTMLElement | null): void {
  if (requestedPane !== scope || !element || element.getClientRects().length === 0) return;
  requestedPane = null;
  focusVimNormal(element);
}

let overlayReturnPane: HTMLElement | null = null;
let overlayReturnUrl: string | null = null;
export function rememberVimOverlayFocus(): void {
  if (document.querySelector("[data-command-palette]")) return;
  overlayReturnUrl = window.location.href;
  overlayReturnPane =
    vimEnabled() && getVimMode() === "normal" ? vimPane(document.activeElement) : null;
}
export function restoreVimOverlayFocus(): boolean {
  const pane = overlayReturnPane;
  overlayReturnPane = null;
  if (!vimEnabled() || !pane) return false;
  if (getVimMode() === "insert" || window.location.href !== overlayReturnUrl) return true;
  focusVimNormal(pane.isConnected ? pane : undefined);
  return true;
}
