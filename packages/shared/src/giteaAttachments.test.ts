import { describe, expect, it } from "vite-plus/test";

import { resolveGiteaAttachmentUrl } from "./giteaAttachments.ts";

const id = "82cde921-c3fc-4c01-85b8-edf737cdaa83";

describe("Gitea attachment URLs", () => {
  it.each([
    `attachments/${id}`,
    `./attachments/${id}`,
    `/attachments/${id}`,
    `https://forge.test/attachments/${id}`,
  ])("resolves %s against the host web root", (source) =>
    expect(resolveGiteaAttachmentUrl(source, "https://forge.test")).toBe(
      `https://forge.test/attachments/${id}`,
    ),
  );

  it.each([
    `attachments/${id}`,
    `/gitea/attachments/${id}`,
    `https://forge.test/gitea/attachments/${id}`,
  ])("preserves the configured proxy subpath for %s", (source) =>
    expect(resolveGiteaAttachmentUrl(source, "https://forge.test/gitea/")).toBe(
      `https://forge.test/gitea/attachments/${id}`,
    ),
  );

  it.each([
    `https://elsewhere.test/attachments/${id}`,
    `//elsewhere.test/attachments/${id}`,
    `https://user:password@forge.test/attachments/${id}`,
    `attachments/${id}?token=secret`,
    "attachments/../../api/v1/user",
    "attachments/not-a-uuid",
    "src/screenshot.png",
    "file:///attachments/example.png",
  ])("rejects non-attachment destinations: %s", (source) => {
    expect(resolveGiteaAttachmentUrl(source, "https://forge.test")).toBeNull();
  });

  it("rejects an attachment outside the configured subpath", () => {
    expect(resolveGiteaAttachmentUrl(`/attachments/${id}`, "https://forge.test/gitea")).toBeNull();
  });
});
