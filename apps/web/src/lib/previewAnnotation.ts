import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { dataUrlToFile } from "./imageCompression";

export type PreviewAnnotationCapture =
  /** The crop is ready to attach. */
  | { readonly status: "captured"; readonly file: File }
  /** The pick carried no crop, which is normal for comment-only annotations. */
  | { readonly status: "none" }
  /** The crop could not be decoded. Send the annotation without it. */
  | { readonly status: "failed" };

/** Decode locally because the desktop CSP does not allow fetching data URLs. */
export function capturePreviewAnnotationScreenshot(
  annotation: PreviewAnnotationPayload,
): PreviewAnnotationCapture {
  if (!annotation.screenshot) return { status: "none" };
  const { dataUrl } = annotation.screenshot;
  const match = /^data:(image\/[^;,]+);base64,.+$/s.exec(dataUrl);
  if (!match?.[1]) return { status: "failed" };
  try {
    return {
      status: "captured",
      file: dataUrlToFile(dataUrl, `preview-annotation-${annotation.id}.png`, match[1]),
    };
  } catch {
    return { status: "failed" };
  }
}
