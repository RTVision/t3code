import type { EditorId, EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useEditorDispatch } from "../editorPreferences";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function KeybindingsConfigWarning({
  message,
  environmentId,
  configPath,
  availableEditors,
}: {
  message: string;
  environmentId: EnvironmentId | null;
  configPath: string | null;
  availableEditors: readonly EditorId[];
}) {
  const { open: openInEditor, canOpen } = useEditorDispatch(environmentId, availableEditors);

  return (
    <>
      {message}
      <span className="mt-2 flex justify-end">
        <Button
          size="xs"
          variant="outline"
          disabled={!canOpen || !configPath}
          onClick={async () => {
            if (!configPath) return;
            const result = await openInEditor(configPath);
            if (result._tag === "Success") return;
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Unable to open keybindings file",
                description: error instanceof Error ? error.message : "Unknown error opening file.",
              }),
            );
          }}
        >
          Open keybindings.json
        </Button>
      </span>
    </>
  );
}
