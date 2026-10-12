import type { AssetResource, SourceControlProviderKind } from "@t3tools/contracts";
import { resolveGiteaAttachmentUrl } from "@t3tools/shared/giteaAttachments";

import {
  findAndReplaceText,
  type MarkdownNode,
  type TextMatch,
} from "~/vendor/mdast-find-and-replace";

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

const AUTOLINK_CANDIDATE_PATTERN = /#[1-9]\d*|[0-9a-f]{40}/giu;
const AUTOLINK_WORD_CHARACTER_PATTERN = /[A-Za-z0-9_]/u;
const AUTOLINK_COMMIT_PREFIX_PATTERN = /[\s([{]/u;
const AUTOLINK_IGNORED_TYPES = new Set(["link", "linkReference"]);

/** GitHub-style same-repository references for pull request prose, never code or authored links. */
export function remarkPullRequestAutolinks(options: { readonly repositoryUrl: string }) {
  const repositoryUrl = options.repositoryUrl.replace(/\/+$/u, "");
  return (tree: MarkdownNode) => {
    findAndReplaceText(
      tree,
      AUTOLINK_CANDIDATE_PATTERN,
      (matched: string, match: TextMatch) => {
        const reference = matched.startsWith("#");
        const before = match.input[match.index - 1];
        const after = match.input[match.index + matched.length];
        if (
          (before !== undefined &&
            (reference
              ? AUTOLINK_WORD_CHARACTER_PATTERN.test(before)
              : !AUTOLINK_COMMIT_PREFIX_PATTERN.test(before))) ||
          (after !== undefined && AUTOLINK_WORD_CHARACTER_PATTERN.test(after))
        ) {
          return false;
        }
        return {
          type: "link",
          url: reference
            ? `${repositoryUrl}/issues/${matched.slice(1)}`
            : `${repositoryUrl}/commit/${matched}`,
          data: {
            hProperties: {
              dataPullRequestAutolink: reference ? "reference" : "commit",
            },
          },
          children: [{ type: "text", value: reference ? matched : matched.slice(0, 7) }],
        };
      },
      AUTOLINK_IGNORED_TYPES,
    );
  };
}
