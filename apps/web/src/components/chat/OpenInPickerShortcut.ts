import type { EditorId, EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect } from "react";

import { useEditorDispatch } from "../../editorPreferences";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "../ui/toast";
import { editorLabelForPlatform } from "../../editorLabels";
import { announce } from "../../lib/announce";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";
import { registerCommands } from "../../shortcuts/dispatcher";

/** Marks an OpenInPicker's primary button as the target of `editor.openFavorite`. */
export const OPEN_FAVORITE_EDITOR_ATTRIBUTE = "data-open-favorite-editor";

/**
 * `editor.openFavorite` presses the marked OpenInPicker primary button, so the shortcut opens
 * exactly what the button on screen would. A missing or disabled button leaves the chord to the
 * bubble-phase fallback below. Capture phase, so a focused terminal does not swallow the chord.
 */
export function registerOpenFavoriteEditorCommand(): () => void {
  return registerCommands(
    {
      "editor.openFavorite": (event) => {
        if (event.repeat) return false;
        const button = [
          ...document.querySelectorAll<HTMLButtonElement>(`[${OPEN_FAVORITE_EDITOR_ATTRIBUTE}]`),
        ].at(-1);
        if (button === undefined || button.disabled) return false;
        event.preventDefault();
        button.click();
      },
    },
    { capture: true },
  );
}

export function useOpenFavoriteEditorShortcut({
  enabled,
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
}: {
  enabled: boolean;
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const dispatch = useEditorDispatch(environmentId, availableEditors, openInCwd);
  const preferredEditor = dispatch.choice;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a window keydown listener for the open-in-editor shortcut while enabled locally
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!openInCwd || !preferredEditor) return;

      event.preventDefault();
      const label = editorLabelForPlatform(preferredEditor.editor, navigator.platform);
      void dispatch.open({ kind: "directory", path: openInCwd }).then((result) => {
        if (isAtomCommandInterrupted(result)) return;
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Unable to open editor",
            description: error instanceof Error ? error.message : "The editor could not be opened.",
          });
          return;
        }
        announce(`Opened in ${label}`);
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dispatch, enabled, keybindings, openInCwd, preferredEditor]);
}
