const ATTACHMENT_PATH = /^attachments\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** Resolves Gitea uploads against its web root, including installations under a subpath. */
export function resolveGiteaAttachmentUrl(source: string, baseUrl: string): string | null {
  try {
    const base = new URL(`${baseUrl.replace(/\/+$/u, "")}/`);
    const url = new URL(source, base);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username !== "" ||
      base.password !== "" ||
      base.search !== "" ||
      base.hash !== "" ||
      url.origin !== base.origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      !url.pathname.startsWith(base.pathname) ||
      !ATTACHMENT_PATH.test(url.pathname.slice(base.pathname.length))
    )
      return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
