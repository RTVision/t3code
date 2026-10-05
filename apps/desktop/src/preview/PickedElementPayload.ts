/**
 * Strict structural validator for `PickedElementPayload` messages received
 * from the in-page picker preload (`apps/desktop/src/preview/PickPreload.ts`)
 * via `wc.ipc`. Lives in its own electron-free module so the validator is
 * trivially unit-testable.
 *
 * Validation must be tight: downstream `normalizeElementContextSelection`
 * calls `.trim()` on incoming strings, so a malformed payload (preload bug,
 * future schema mismatch, malicious page that intercepts the preload's IPC
 * channel via prototype pollution) would otherwise throw deep in the
 * renderer and the chip silently never appears.
 */
import type {
  PickedElementPayload,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  PreviewAnnotationRegionTarget,
  PreviewAnnotationStrokeTarget,
  PreviewAnnotationStyleChange,
} from "@t3tools/contracts";

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isPickedStackFrame(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    isStringOrNull(frame["functionName"]) &&
    isStringOrNull(frame["fileName"]) &&
    isFiniteNumberOrNull(frame["lineNumber"]) &&
    isFiniteNumberOrNull(frame["columnNumber"])
  );
}

export function isPickedElementPayload(value: unknown): value is PickedElementPayload {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c["pageUrl"] !== "string") return false;
  if (typeof c["tagName"] !== "string") return false;
  if (typeof c["htmlPreview"] !== "string") return false;
  if (typeof c["styles"] !== "string") return false;
  if (typeof c["pickedAt"] !== "string") return false;
  if (!isStringOrNull(c["pageTitle"])) return false;
  if (!isStringOrNull(c["selector"])) return false;
  if (!isStringOrNull(c["componentName"])) return false;
  if (c["source"] !== null && !isPickedStackFrame(c["source"])) return false;
  if (!Array.isArray(c["stack"])) return false;
  if (!c["stack"].every(isPickedStackFrame)) return false;
  return true;
}

function isRect(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (key) => typeof rect[key] === "number" && Number.isFinite(rect[key]),
  );
}

function isPoint(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point["x"] === "number" &&
    Number.isFinite(point["x"]) &&
    typeof point["y"] === "number" &&
    Number.isFinite(point["y"])
  );
}

function isArrayOf(value: unknown, isEntry: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(isEntry);
}

function isRegionTarget(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return typeof target["id"] === "string" && isRect(target["rect"]);
}

function isStrokeTarget(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target["id"] === "string" &&
    typeof target["color"] === "string" &&
    typeof target["width"] === "number" &&
    Number.isFinite(target["width"]) &&
    isArrayOf(target["points"], isPoint) &&
    isRect(target["bounds"])
  );
}

function isStyleChange(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Record<string, unknown>;
  return (
    typeof change["targetId"] === "string" &&
    isStringOrNull(change["selector"]) &&
    typeof change["property"] === "string" &&
    typeof change["previousValue"] === "string" &&
    typeof change["value"] === "string"
  );
}

export function isPreviewAnnotationPayload(value: unknown): value is PreviewAnnotationPayload {
  if (typeof value !== "object" || value === null) return false;
  const annotation = value as Record<string, unknown>;
  if (typeof annotation["id"] !== "string") return false;
  if (typeof annotation["pageUrl"] !== "string") return false;
  if (!isStringOrNull(annotation["pageTitle"])) return false;
  if (typeof annotation["comment"] !== "string") return false;
  if (typeof annotation["createdAt"] !== "string") return false;
  if (annotation["screenshot"] !== null) return false;

  return (
    isArrayOf(annotation["elements"], (entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const target = entry as Record<string, unknown>;
      return (
        typeof target["id"] === "string" &&
        isPickedElementPayload(target["element"]) &&
        isRect(target["rect"])
      );
    }) &&
    isArrayOf(annotation["regions"], isRegionTarget) &&
    isArrayOf(annotation["strokes"], isStrokeTarget) &&
    isArrayOf(annotation["styleChanges"], isStyleChange)
  );
}

export type PreviewAnnotationTool = "select" | "marquee" | "draw" | "erase";

/**
 * An in-progress markup that outlives a reload of the inspected page. The
 * preload keeps main's copy current, and main hands it back to the fresh
 * document so a dev-server refresh does not throw the user's comment away.
 * Selected elements travel as a CSS path plus their last rect, because the
 * DOM nodes themselves do not survive the reload.
 */
export interface PreviewAnnotationDraft {
  readonly comment: string;
  readonly tool: PreviewAnnotationTool;
  readonly elements: ReadonlyArray<{
    readonly id: string;
    readonly selector: string;
    readonly rect: PreviewAnnotationRect;
  }>;
  readonly regions: ReadonlyArray<PreviewAnnotationRegionTarget>;
  readonly strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>;
  readonly styleChanges: ReadonlyArray<PreviewAnnotationStyleChange>;
}

const ANNOTATION_TOOLS: ReadonlySet<unknown> = new Set(["select", "marquee", "draw", "erase"]);

export function isPreviewAnnotationDraft(value: unknown): value is PreviewAnnotationDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft["comment"] === "string" &&
    ANNOTATION_TOOLS.has(draft["tool"]) &&
    isArrayOf(draft["elements"], (entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const target = entry as Record<string, unknown>;
      return (
        typeof target["id"] === "string" &&
        typeof target["selector"] === "string" &&
        isRect(target["rect"])
      );
    }) &&
    isArrayOf(draft["regions"], isRegionTarget) &&
    isArrayOf(draft["strokes"], isStrokeTarget) &&
    isArrayOf(draft["styleChanges"], isStyleChange)
  );
}
