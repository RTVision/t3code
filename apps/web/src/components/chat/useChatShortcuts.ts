import { onAppCommand } from "../../vim/commandBus";
import { vimEnabled } from "../../vim/runtime";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveChatShortcutCommand, type ShortcutMatchContext } from "../../keybindings";
import { isTerminalCloseConfirmPending } from "../../lib/terminalCloseConfirm";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "../../lib/terminalCloseShortcut";
import { getTerminalFocusOwner, type TerminalFocusOwner } from "../../lib/terminalFocus";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { BranchToolbarHandle } from "../BranchToolbar";
import { shouldTypeToFocusComposer } from "./composerFocusRedirect";
import { composerShortcutCommands } from "./composerShortcuts";

/** Returning false lets the key event through untouched. */
type ChatShortcutHandler = (context: {
  readonly event: KeyboardEvent;
  readonly terminalFocusOwner: TerminalFocusOwner | null;
}) => boolean | void;

export type ChatShortcutCommands = Partial<Record<KeybindingCommand, ChatShortcutHandler>>;

export interface ChatShortcutsInput {
  readonly enabled: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly scriptKeybindings: ResolvedKeybindingsConfig;
  readonly getShortcutContext: (target: EventTarget | null) => ShortcutMatchContext & {
    readonly modelPickerOpen: boolean;
  };
  readonly threadFindActive: boolean;
  /** Takes type-to-focus keys and the composer and branch toolbar chords. */
  readonly composerRef: ComposerHandleRef;
  readonly branchToolbarRef: { readonly current: BranchToolbarHandle | null };
  readonly closeThreadFind: () => void;
  readonly commands: ChatShortcutCommands;
  /** Handles commands not in `commands`, such as project scripts. */
  readonly fallback: (command: KeybindingCommand) => ChatShortcutHandler | undefined;
}

/**
 * The chat's window keyboard shortcuts, plus Escape closing thread find.
 * Listeners attach once; the effect events read the latest input, so handlers
 * act on the current render without re-registering on every change.
 */
export function useChatShortcuts(input: ChatShortcutsInput) {
  const handleShortcut = useEffectEvent(
    (event: KeyboardEvent, requestedCommand?: KeybindingCommand) => {
      const { keybindings } = input;
      if (preventRepeatedTerminalCloseShortcut(event, keybindings)) {
        event.stopPropagation();
        return;
      }
      if (input.threadFindActive && event.key === "Escape") return;
      if (isTerminalCloseConfirmPending() && preventTerminalCloseShortcut(event, keybindings)) {
        event.stopPropagation();
        return;
      }
      if (!input.enabled || isCommandPaletteOpen()) return;
      const terminalFocusOwner = requestedCommand
        ? (document.activeElement
            ?.closest("[data-terminal-owner]")
            ?.getAttribute("data-terminal-owner") as TerminalFocusOwner | null)
        : getTerminalFocusOwner();
      if (event.defaultPrevented && !requestedCommand && terminalFocusOwner === null) return;
      const shortcutContext = input.getShortcutContext(event.target);

      if (
        !vimEnabled() &&
        !requestedCommand &&
        !shortcutContext.terminalFocus &&
        !shortcutContext.modelPickerOpen &&
        shouldTypeToFocusComposer(event) &&
        input.composerRef.current?.insertTextAtEnd(event.key) === true
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const command =
        requestedCommand ??
        resolveChatShortcutCommand(event, keybindings, input.scriptKeybindings, {
          context: shortcutContext,
        });
      if (!command) return;
      const run =
        input.commands[command] ??
        composerShortcutCommands(input.composerRef, input.branchToolbarRef)[command] ??
        input.fallback(command);
      if (!run || run({ event, terminalFocusOwner }) === false) return;
      event.preventDefault();
      event.stopPropagation();
    },
  );
  const dismissFind = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      !input.threadFindActive ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      isCommandPaletteOpen()
    )
      return;
    const context = input.getShortcutContext(event.target);
    if (context.terminalFocus || context.previewFocus || context.modelPickerOpen) return;
    event.preventDefault();
    input.closeThreadFind();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches window keydown listeners for chat shortcuts and find dismissal for the component's lifetime
  useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent) => handleShortcut(event);
    const onKeyDown = (event: KeyboardEvent) => dismissFind(event);
    const unsubscribeCommand = onAppCommand((event, command) => handleShortcut(event, command));
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      unsubscribeCommand();
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
