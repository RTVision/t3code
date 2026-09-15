import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { capturePreviewAnnotationScreenshot } from "./previewAnnotation";

const annotation: PreviewAnnotationPayload = {
  id: "annotation_1",
  pageUrl: "http://localhost:3000",
  pageTitle: "Example",
  comment: "Make these cards feel related.",
  elements: [],
  regions: [{ id: "region_1", rect: { x: 10, y: 20, width: 100, height: 80 } }],
  strokes: [
    {
      id: "stroke_1",
      color: "#7c3aed",
      width: 4,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      bounds: { x: 6, y: 6, width: 18, height: 18 },
    },
  ],
  styleChanges: [
    {
      targetId: "element_1",
      selector: ".card",
      property: "border-radius",
      previousValue: "4px",
      value: "16px",
    },
  ],
  screenshot: {
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 80,
    cropRect: { x: 10, y: 20, width: 100, height: 80 },
  },
  createdAt: "2026-06-11T00:00:00.000Z",
};

describe("preview annotation capture", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes the screenshot when desktop CSP blocks data URL fetches", async () => {
    vi.stubGlobal("fetch", () => {
      throw new TypeError("Refused to connect because it violates Content Security Policy");
    });
    const capture = capturePreviewAnnotationScreenshot(annotation);
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") throw new Error("Screenshot was dropped");
    expect(capture.file.name).toBe("preview-annotation-annotation_1.png");
    expect(capture.file.type).toBe("image/png");
    expect(new Uint8Array(await capture.file.arrayBuffer())).toEqual(new Uint8Array([0]));
  });

  it("reports none when the annotation carries no crop", () => {
    expect(capturePreviewAnnotationScreenshot({ ...annotation, screenshot: null })).toEqual({
      status: "none",
    });
  });

  it.each([
    "data:image/png;base64,not!base64",
    "data:image/png;base64,",
    "data:image/png,not-base64",
    "https://example.com/screenshot.png",
  ])("reports a failed conversion for an invalid screenshot: %s", (dataUrl) => {
    expect(
      capturePreviewAnnotationScreenshot({
        ...annotation,
        screenshot: { ...annotation.screenshot!, dataUrl },
      }),
    ).toEqual({ status: "failed" });
  });
});
