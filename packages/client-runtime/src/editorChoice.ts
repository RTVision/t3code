import {
  EDITORS,
  type DesktopEditorConnectionRef,
  type EditorChoice,
  type EditorId,
  type EditorOpenTarget,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { ConnectionTarget } from "./connection/model.ts";
import { splitFilePathPosition, formatFilePathPosition } from "./markdownLinks.ts";

export function terminalEditorConnectionRef(
  target: ConnectionTarget | null,
  environmentId: EnvironmentId | null,
): DesktopEditorConnectionRef | null {
  if (!target || !environmentId) return null;
  if (target._tag === "PrimaryConnectionTarget") return { kind: "primary" };
  if (target._tag === "BearerConnectionTarget" && target.connectionId.startsWith("local:"))
    return { kind: "local", backendId: target.connectionId.slice(6) };
  return { kind: "saved", environmentId };
}
export function resolveEditorChoice(
  explicit: EditorChoice | null,
  fallback: EditorChoice | null,
  legacy: EditorId | null,
  available: readonly EditorId[],
): EditorChoice | null {
  if (explicit) return explicit;
  if (fallback?.kind === "terminal") return fallback;
  const preferred = fallback?.editor ?? legacy;
  const editor =
    preferred && available.includes(preferred)
      ? preferred
      : EDITORS.find((editor) => available.includes(editor.id))?.id;
  return editor ? { kind: "gui", editor } : null;
}
/** Legacy links follow VS Code's one-based UTF-16 convention; new callers can send byte columns explicitly. */
export function editorTargetFromLegacy(path: string): EditorOpenTarget {
  return { kind: "file", ...splitFilePathPosition(path), columnEncoding: "utf-16" };
}
export function guiEditorTarget(target: EditorOpenTarget): string {
  return target.kind === "directory" ? target.path : formatFilePathPosition(target);
}
export function editorWorkspace(target: EditorOpenTarget, workspace?: string | null): string {
  if (workspace) return workspace;
  if (target.kind === "directory") return target.path;
  const separator = target.path.startsWith("/") ? "/" : "\\";
  const normalized = separator === "\\" ? target.path.replaceAll("/", "\\") : target.path;
  const index = normalized.lastIndexOf(separator);
  if (index < 0) return ".";
  if (index === 0) return "/";
  if (index === 2 && /^[A-Za-z]:/u.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, index);
}
