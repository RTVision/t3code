import * as Schema from "effect/Schema";
import type { PullRequestReaction, PullRequestReactionContent } from "@t3tools/contracts";

const RawReactionUser = Schema.Struct({
  login: Schema.optional(Schema.String),
});

/** The shape returned by Gitea's issue and issue-comment reaction endpoints. */
export const RawGiteaReaction = Schema.Struct({
  reaction: Schema.optional(Schema.String),
  user: Schema.optional(Schema.NullOr(RawReactionUser)),
});

export type GiteaConversationReactionTarget =
  | { readonly kind: "pull-request" }
  | { readonly kind: "comment"; readonly id: string };

const reactionContent = new Map<string, PullRequestReactionContent>([
  ["+1", "thumbs-up"],
  ["-1", "thumbs-down"],
  ["laugh", "laugh"],
  ["hooray", "hooray"],
  ["confused", "confused"],
  ["heart", "heart"],
  ["rocket", "rocket"],
  ["eyes", "eyes"],
]);

const giteaReactionContent = new Map<PullRequestReactionContent, string>(
  [...reactionContent].map(([gitea, content]) => [content, gitea]),
);

function commentId(subjectId: string): string | null {
  const [kind, id] = subjectId.split(":", 2);
  if ((kind !== "issue" && kind !== "review-comment") || !id || !/^\d+$/.test(id)) return null;
  return id;
}

/**
 * Gitea stores inline review remarks as issue comments. Review summaries use a separate Review
 * record, for which v1.27.3 intentionally exposes neither an edit nor a reaction endpoint.
 */
export function reactionTarget(
  subjectId: string | undefined,
): GiteaConversationReactionTarget | null {
  if (subjectId === undefined) return { kind: "pull-request" };
  const id = commentId(subjectId);
  return id === null ? null : { kind: "comment", id };
}

/** Returns the native issue-comment ID for both ordinary and inline-review remarks. */
export function editableCommentId(subjectId: string): string | null {
  return commentId(subjectId);
}

export function nativeReactionContent(content: PullRequestReactionContent): string {
  return giteaReactionContent.get(content) ?? content;
}

/** Reduces Gitea's one-row-per-user reactions to the cross-provider reaction pill shape. */
export function reactionsForViewer(
  rows: ReadonlyArray<typeof RawGiteaReaction.Type>,
  viewer: string,
): ReadonlyArray<PullRequestReaction> {
  const groups = new Map<
    PullRequestReactionContent,
    { count: number; actors: Array<string>; viewerHasReacted: boolean }
  >();
  for (const row of rows) {
    const content = row.reaction === undefined ? undefined : reactionContent.get(row.reaction);
    if (content === undefined) continue;
    const group = groups.get(content) ?? { count: 0, actors: [], viewerHasReacted: false };
    group.count += 1;
    const login = row.user?.login?.trim();
    if (login !== undefined && login !== "") {
      if (login.toLowerCase() === viewer.toLowerCase()) group.viewerHasReacted = true;
      else group.actors.push(login);
    }
    groups.set(content, group);
  }
  return [...groups].map(([content, group]) => ({ content, ...group }));
}
