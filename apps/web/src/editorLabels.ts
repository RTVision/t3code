import { EDITORS, type EditorId } from "@t3tools/contracts";

import { getLocalFileManagerName } from "~/lib/utils";
import { msg } from "gt-react";

import { m, type MessageResolver } from "./i18n/messages";

const editorLabels = new Map<EditorId, string>(EDITORS.map((editor) => [editor.id, editor.label]));

export function editorLabelForPlatform(
  editorId: EditorId | "neovim",
  platform: string,
  resolve: MessageResolver = m,
): string {
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Neovim is a product name.
  if (editorId === "neovim") return "Neovim";
  if (editorId === "file-manager") {
    return getLocalFileManagerName(platform, resolve);
  }

  return (
    editorLabels.get(editorId) ?? resolve(msg("Editor", { $context: "noun, a code editor app" }))
  );
}

export function openInEditorMenuLabel(
  editorId: EditorId | "neovim" | null,
  resolve: MessageResolver = m,
): string {
  if (editorId === "neovim")
    return resolve(msg("Open in {editor}", { editor: "Neovim (Terminal)" }));
  return editorId === null || editorId === "file-manager"
    ? resolve(msg("Open in editor"))
    : resolve(
        msg("Open in {editor}", {
          editor:
            editorLabels.get(editorId) ??
            resolve(msg("Editor", { $context: "noun, a code editor app" })),
        }),
      );
}
