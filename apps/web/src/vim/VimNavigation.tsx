import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { useClientSettings } from "../hooks/useSettings";
import { dispatchAppCommand } from "./commandBus";
import {
  advanceSequence,
  EMPTY_SEQUENCE,
  parseSequence,
  resolveVimBindings,
  strokeFromEvent,
  type SequenceState,
  type VimBinding,
} from "./bindings";
import {
  dispatchVimAction,
  focusVimNormal,
  requestVimPaneFocus,
  getVimMode,
  setVimMode,
  useVimMode,
  vimPane,
  vimScope,
} from "./runtime";

const overlaySelector =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="popover-popup"], [role="listbox"], [data-keybinding-capture], [data-vim-search]';
const inputSelector = 'input, textarea, [contenteditable="true"]';
function visible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth &&
    !element.closest("[inert]")
  );
}
function selectionPresent(): boolean {
  const element = document.activeElement;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    return element.selectionStart !== element.selectionEnd;
  return Boolean(window.getSelection()?.toString());
}
function focusNeighbor(direction: string): void {
  const current = vimPane(document.activeElement);
  const panes = Array.from(document.querySelectorAll<HTMLElement>("[data-vim-pane]")).filter(
    visible,
  );
  const rect = current?.getBoundingClientRect();
  if (!rect) {
    focusVimNormal(panes[0]);
    return;
  }
  const x = rect.x + rect.width / 2,
    y = rect.y + rect.height / 2;
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  const target = panes
    .filter((pane) => pane !== current)
    .map((pane) => {
      const candidate = pane.getBoundingClientRect();
      const dx = candidate.x + candidate.width / 2 - x;
      const dy = candidate.y + candidate.height / 2 - y;
      return { pane, ahead: (horizontal ? dx : dy) * sign, across: Math.abs(horizontal ? dy : dx) };
    })
    .filter(({ ahead }) => ahead > 1)
    .sort((a, b) => a.ahead + a.across * 2 - (b.ahead + b.across * 2))[0];
  if (target) focusVimNormal(target.pane);
}

/** One capture owner decides whether a stroke belongs to Vim or the focused input. */
export function VimNavigation() {
  const settings = useClientSettings((value) => value.vim);
  const mode = useVimMode();
  const bindings = useMemo(() => resolveVimBindings(settings), [settings]);
  const [pending, setPending] = useState("");
  const [guide, setGuide] = useState<readonly VimBinding[]>([]);
  const [help, setHelp] = useState(false);
  const sequence = useRef<SequenceState>(EMPTY_SEQUENCE);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const guideTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const config = useRef({ settings, bindings });
  useLayoutEffect(() => {
    config.current = { settings, bindings };
  }, [settings, bindings]);
  useLayoutEffect(() => {
    function clear() {
      sequence.current = EMPTY_SEQUENCE;
      clearTimeout(timeout.current);
      clearTimeout(guideTimeout.current);
      setPending("");
      setGuide([]);
    }

    function focus(event: FocusEvent) {
      if (!config.current.settings.enabled) return;
      clear();
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest(overlaySelector)) return;
      if (target?.matches(inputSelector)) {
        setVimMode(vimScope(target) === "terminal" ? "terminal" : "insert");
      } else if (vimPane(target)) setVimMode("normal");
    }
    function keydown(event: KeyboardEvent) {
      const { settings, bindings } = config.current;
      if (!settings.enabled) {
        clear();
        return;
      }
      if (
        event.isComposing ||
        event.key === "Process" ||
        event.key === "Dead" ||
        ["Control", "Shift", "Alt", "Meta"].includes(event.key)
      )
        return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target?.closest("[data-keybinding-capture]") ||
        window.location.pathname.startsWith("/settings")
      ) {
        clear();
        return;
      }
      const pane = vimPane(target);
      const ownsInput = (element: HTMLElement) =>
        visible(element) &&
        !(
          element.getAttribute("role") === "dialog" &&
          pane?.dataset.vimPane === "diff" &&
          element.contains(pane)
        );
      const closestOverlay = target?.closest<HTMLElement>(overlaySelector);
      const overlay =
        (closestOverlay && ownsInput(closestOverlay) ? closestOverlay : null) ??
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="popover-popup"], [data-composer-command-drawer="true"], [data-slot="select-popup"], [data-slot="combobox-popup"]',
          ),
        ).find(ownsInput);
      if (overlay) {
        clear();
        // Picker navigation remains text-first. Let each widget own selection and dismissal.
        if (
          event.ctrlKey &&
          !event.altKey &&
          !event.metaKey &&
          (event.key === "n" || event.key === "p") &&
          target
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          target.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: event.key === "n" ? "ArrowDown" : "ArrowUp",
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        return;
      }
      const scope =
        vimScope(target ?? document.activeElement) === "other" &&
        (target === document.body || target === document.documentElement)
          ? vimScope(document.querySelector('[data-vim-pane="chat"]'))
          : vimScope(target ?? document.activeElement);
      if (scope === "other") return;
      const currentMode = getVimMode();
      const stroke = strokeFromEvent(event);
      const normalBinding = bindings.find((binding) => binding.command === "mode.normal");
      if (
        (sequence.current.strokes.length > 0 || sequence.current.count) &&
        normalBinding?.modes.includes(currentMode) &&
        normalBinding.keys.some((key) => parseSequence(key).join(" ") === stroke)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        clear();
        setHelp(false);
        return;
      }
      const result = advanceSequence(sequence.current, stroke, bindings, currentMode, scope);
      if (!result.consumed) return;
      if (result.command === "mode.normal" && stroke === "ctrl+c" && selectionPresent()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      sequence.current = result.state;
      clearTimeout(timeout.current);
      clearTimeout(guideTimeout.current);
      setPending(result.state.count + result.state.strokes.join(" "));
      setGuide([]);
      if (result.command) {
        if (event.repeat && !/^(move\.|message\.|hunk\.)/.test(result.command)) return;
        clear();
        const command = result.command;
        if (command === "terminal.escape" || command === "mode.normal") {
          setHelp(false);
          focusVimNormal(vimPane(target));
          return;
        }
        if (command === "help") {
          setHelp((value) => !value);
          return;
        }
        if (command.startsWith("pane.") && command !== "pane.close") {
          focusNeighbor(command.slice(5));
          return;
        }
        if (dispatchVimAction({ command, scope, count: result.count ?? 1, event })) return;
        const appCommand =
          command === "threadPicker.open"
            ? "commandPalette.toggle"
            : command === "pane.close"
              ? scope === "terminal"
                ? "terminal.close"
                : "rightPanel.close"
              : command;
        const supported = STATIC_KEYBINDING_COMMANDS.find((entry) => entry === appCommand);
        if (supported) {
          if (command === "diff.toggle") requestVimPaneFocus("diff");
          if (command === "sidebar.toggle") requestVimPaneFocus("sidebar");
          dispatchAppCommand(supported, event);
        }
      } else {
        timeout.current = setTimeout(clear, settings.sequenceTimeoutMs);
        if (settings.guideEnabled && result.candidates)
          guideTimeout.current = setTimeout(
            () => setGuide(result.candidates ?? []),
            settings.guideDelayMs,
          );
      }
    }
    window.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focus);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focus);
      window.removeEventListener("blur", clear);
      clearTimeout(timeout.current);
      clearTimeout(guideTimeout.current);
    };
  }, []);

  if (!settings.enabled) return null;
  const shown = help ? bindings : guide;
  return (
    <div
      className="fixed bottom-2 left-2 z-[60] max-w-sm rounded border bg-popover px-2 py-1 text-xs text-popover-foreground shadow"
      data-vim-status
    >
      <div aria-live="polite">
        <span className="font-mono uppercase">{mode}</span>
        {pending && <span className="ml-3 font-mono">{pending}</span>}
      </div>
      {shown.length > 0 && (
        <div className="mt-2 max-h-72 overflow-auto" aria-label="Vim shortcuts">
          {shown
            .filter((binding) => binding.keys.length > 0 && binding.modes.includes(mode))
            .map((binding) => (
              <div key={binding.command} className="flex justify-between gap-4 py-0.5">
                <kbd>{binding.keys.join(" / ")}</kbd>
                <span>{binding.label}</span>
              </div>
            ))}
          {help && (
            <button type="button" className="mt-2 underline" onClick={() => setHelp(false)}>
              Close help
            </button>
          )}
        </div>
      )}
    </div>
  );
}
