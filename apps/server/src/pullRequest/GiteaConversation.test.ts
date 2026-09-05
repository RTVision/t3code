import { describe, expect, it } from "@effect/vitest";

import {
  editableCommentId,
  nativeReactionContent,
  RawGiteaReaction,
  reactionsForViewer,
  reactionTarget,
} from "./GiteaConversation.ts";

describe("GiteaConversation", () => {
  it("addresses ordinary and inline review remarks through the same issue-comment record", () => {
    expect(editableCommentId("issue:12")).toBe("12");
    expect(editableCommentId("review-comment:34")).toBe("34");
    expect(reactionTarget("review:56")).toBeNull();
  });

  it("distinguishes a pull request description from a comment and rejects malformed ids", () => {
    expect(reactionTarget(undefined)).toEqual({ kind: "pull-request" });
    expect(reactionTarget("issue:12")).toEqual({ kind: "comment", id: "12" });
    expect(editableCommentId("issue:12/../../private")).toBeNull();
  });

  it("groups supported Gitea reactions and names the signed-in viewer separately", () => {
    const rows: ReadonlyArray<typeof RawGiteaReaction.Type> = [
      { reaction: "+1", user: { login: "Reader" } },
      { reaction: "+1", user: { login: "teammate" } },
      { reaction: "heart", user: { login: "friend" } },
      { reaction: "party", user: { login: "ignored" } },
    ];

    expect(reactionsForViewer(rows, "reader")).toEqual([
      { content: "thumbs-up", count: 2, actors: ["teammate"], viewerHasReacted: true },
      { content: "heart", count: 1, actors: ["friend"], viewerHasReacted: false },
    ]);
  });

  it("uses Gitea's reaction spelling on writes", () => {
    expect(nativeReactionContent("thumbs-up")).toBe("+1");
    expect(nativeReactionContent("heart")).toBe("heart");
  });
});
