import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import {
  type PendingReviewComment,
  pullRequestReviewKey,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

function comment(id: string, body = id): PendingReviewComment {
  return { id, body, path: "src/app.ts", position: { kind: "added", newLine: 1 } };
}

describe("pull request review drafts", () => {
  beforeEach(() => {
    usePullRequestReviewStore.setState({ drafts: {}, summaries: {} });
  });

  it("removes only the line comments included in a submitted snapshot", () => {
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", comment("submitted"));
    const submitted = usePullRequestReviewStore.getState().drafts["review-a"] ?? [];

    usePullRequestReviewStore.getState().addComment("review-a", comment("added-in-flight"));
    usePullRequestReviewStore.getState().removeComments("review-a", submitted);

    expect(usePullRequestReviewStore.getState().drafts["review-a"]).toEqual([
      comment("added-in-flight"),
    ]);
  });

  it("keeps a comment rewritten while the review that sent it was in flight", () => {
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", comment("sent"));
    store.addComment("review-a", comment("edited-in-flight"));
    const submitted = usePullRequestReviewStore.getState().drafts["review-a"] ?? [];

    store.updateComment("review-a", "edited-in-flight", "Rewritten");
    store.removeComments("review-a", submitted);

    expect(usePullRequestReviewStore.getState().drafts["review-a"]).toEqual([
      comment("edited-in-flight", "Rewritten"),
    ]);
  });

  it("rewrites one pending comment in place and ignores a comment already gone", () => {
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", comment("first"));
    store.addComment("review-a", comment("second"));
    store.updateComment("review-a", "first", "Edited");
    const afterEdit = usePullRequestReviewStore.getState().drafts;
    store.updateComment("review-a", "removed", "Lost");

    expect(usePullRequestReviewStore.getState().drafts).toBe(afterEdit);
    expect(afterEdit["review-a"]).toEqual([comment("first", "Edited"), comment("second")]);
  });

  it("keeps summary bodies isolated by review key", () => {
    const store = usePullRequestReviewStore.getState();
    store.setSummary("review-a", "Summary A");
    store.setSummary("review-b", "Summary B");
    store.clearSummary("review-a", "Summary A");

    expect(usePullRequestReviewStore.getState().summaries).toEqual({
      "review-b": "Summary B",
    });
  });

  it("keeps drafts on different hosts separate when a thread reviews the same repository and number", () => {
    const reference = {
      projectId: ProjectId.make("project-a"),
      repository: "owner/repo",
      number: 7,
    };
    const publicKey = pullRequestReviewKey({ ...reference, host: "github.com" });
    const enterpriseKey = pullRequestReviewKey({ ...reference, host: "github.example.com" });
    const store = usePullRequestReviewStore.getState();
    store.addComment(publicKey, comment("public"));
    store.setSummary(publicKey, "Public review");

    expect(usePullRequestReviewStore.getState().drafts[enterpriseKey]).toBeUndefined();
    expect(usePullRequestReviewStore.getState().summaries[enterpriseKey]).toBeUndefined();

    store.addComment(enterpriseKey, comment("enterprise"));
    store.setSummary(enterpriseKey, "Enterprise review");
    store.clear(enterpriseKey);
    store.clearSummary(enterpriseKey, "Enterprise review");

    expect(usePullRequestReviewStore.getState().drafts[publicKey]).toEqual([comment("public")]);
    expect(usePullRequestReviewStore.getState().summaries[publicKey]).toBe("Public review");
  });

  it("does not clear a summary revised while submission is in flight", () => {
    const store = usePullRequestReviewStore.getState();
    store.setSummary("review-a", "Submitted body");
    usePullRequestReviewStore.getState().setSummary("review-a", "Revised body");
    usePullRequestReviewStore.getState().clearSummary("review-a", "Submitted body");

    expect(usePullRequestReviewStore.getState().summaries["review-a"]).toBe("Revised body");
  });
});
