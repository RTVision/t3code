import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

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
    expect(reactionTarget("review:56")).toEqual({ kind: "review", id: "56" });
  });

  it("distinguishes a pull request description from a comment and rejects malformed ids", () => {
    expect(reactionTarget(undefined)).toEqual({ kind: "pull-request" });
    expect(reactionTarget("issue:12")).toEqual({ kind: "comment", id: "12" });
    expect(editableCommentId("issue:12/../../private")).toBeNull();
  });

  it("groups supported Gitea reactions and names the signed-in viewer separately", () => {
    const rows: ReadonlyArray<typeof RawGiteaReaction.Type> = [
      { content: "+1", user: { login: "Reader" } },
      { content: "+1", user: { login: "teammate" } },
      { content: "heart", user: { login: "friend" } },
      { content: "party", user: { login: "ignored" } },
    ];

    expect(reactionsForViewer(rows, "reader")).toEqual([
      { content: "thumbs-up", count: 2, actors: ["teammate"], viewerHasReacted: true },
      { content: "heart", count: 1, actors: ["friend"], viewerHasReacted: false },
    ]);
  });

  it("decodes and groups the native Gitea reaction response shape", () => {
    const decodeReaction = Schema.decodeUnknownSync(RawGiteaReaction);
    const row = decodeReaction({
      content: "+1",
      created_at: "2026-09-05T00:00:00Z",
      user: { id: 7, login: "kalvens", full_name: "Kalven" },
    });

    expect(reactionsForViewer([row], "Kalvens")).toEqual([
      { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
    ]);
  });

  it("uses Gitea's reaction spelling on writes", () => {
    expect(nativeReactionContent("thumbs-up")).toBe("+1");
    expect(nativeReactionContent("heart")).toBe("heart");
  });
});
