import { describe, expect, it } from "@effect/vitest";
import type { PullRequestCapabilities } from "@t3tools/contracts";

import { giteaForkCapabilities } from "./GiteaForkCapabilities.ts";

const base: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [],
  mergeMethods: [],
  search: false,
  reactions: false,
  reactionSubjects: {
    changeRequest: true,
    issueComment: true,
    reviewComment: true,
    review: false,
  },
  review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
  reviewers: { request: true, listCandidates: true },
};

describe("GiteaForkCapabilities", () => {
  it("offers fork-only actions only when the server advertises them", () => {
    const available: PullRequestCapabilities = {
      ...base,
      actions: ["merge", "approve-workflows", "revert"],
    };
    expect(giteaForkCapabilities(available, []).actions).toEqual(["merge"]);
    expect(giteaForkCapabilities(available, ["actions-run-approve"]).actions).toEqual([
      "merge",
      "approve-workflows",
    ]);
    expect(giteaForkCapabilities(available, ["pull-revert"]).actions).toEqual(["merge", "revert"]);
    expect(available.actions).toEqual(["merge", "approve-workflows", "revert"]);
  });
  it("enables review-summary reactions only for an advertising server", () => {
    expect(giteaForkCapabilities(base, []).reactionSubjects?.review).toBe(false);
    expect(giteaForkCapabilities(base, ["pull-review-reactions"]).reactionSubjects?.review).toBe(
      true,
    );
    expect(base.reactionSubjects?.review).toBe(false);
  });
});
