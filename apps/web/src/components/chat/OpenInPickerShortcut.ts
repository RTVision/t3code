import type { EditorId, EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect } from "react";

import { useEditorDispatch } from "../../editorPreferences";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "../ui/toast";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";

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

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!openInCwd || !preferredEditor) return;

      event.preventDefault();
      void dispatch.open({ kind: "directory", path: openInCwd }).then((result) => {
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to open editor",
          description: error instanceof Error ? error.message : "The editor could not be opened.",
        });
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dispatch, enabled, keybindings, openInCwd, preferredEditor]);
}
