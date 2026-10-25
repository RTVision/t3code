import type { AssetResource, SourceControlProviderKind } from "@t3tools/contracts";
import { resolveGiteaAttachmentUrl } from "@t3tools/shared/giteaAttachments";
import type { ReferenceAutolink } from "@t3tools/client-runtime/source-control-clients";

export function resolvePullRequestImageAsset(
  source: string,
  provider: SourceControlProviderKind | null | undefined,
  repositoryUrl: string | null | undefined,
): Extract<AssetResource, { _tag: "source-control-image" }> | null {
  if (provider !== "gitea" || !repositoryUrl) return null;
  try {
    const baseUrl = new URL("../../", `${repositoryUrl.replace(/\/+$/u, "")}/`).href;
    const url = resolveGiteaAttachmentUrl(source, baseUrl);
    return url ? { _tag: "source-control-image", provider: "gitea", url } : null;
  } catch {
    return null;
  }
}

export {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  data?: unknown;
};

const AUTOLINK_IGNORED_TYPES = new Set(["link", "linkReference"]);

export function remarkPullRequestAutolinks(options: {
  readonly autolinks: (text: string) => ReadonlyArray<ReferenceAutolink>;
}) {
  const visit = (node: MarkdownNode): void => {
    const children = node.children;
    if (children === undefined) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (AUTOLINK_IGNORED_TYPES.has(child.type)) continue;
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        continue;
      }
      const value = child.value;
      const links = options.autolinks(value);
      if (links.length === 0) continue;
      const replacements: MarkdownNode[] = [];
      let start = 0;
      for (const link of links) {
        if (start < link.index) {
          replacements.push({ type: "text", value: value.slice(start, link.index) });
        }
        replacements.push({
          type: "link",
          url: link.url,
          data: { hProperties: { dataPullRequestAutolink: link.kind } },
          children: [{ type: "text", value: link.label }],
        });
        start = link.index + link.text.length;
      }
      if (start < value.length) replacements.push({ type: "text", value: value.slice(start) });
      children.splice(index, 1, ...replacements);
      index += replacements.length - 1;
    }
  };
  return (tree: MarkdownNode) => visit(tree);
}
