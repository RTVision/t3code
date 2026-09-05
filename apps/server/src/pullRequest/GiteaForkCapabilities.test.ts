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
  it("enables review-summary reactions only for an advertising server", () => {
    expect(giteaForkCapabilities(base, []).reactionSubjects?.review).toBe(false);
    expect(giteaForkCapabilities(base, ["pull-review-reactions"]).reactionSubjects?.review).toBe(
      true,
    );
    expect(base.reactionSubjects?.review).toBe(false);
  });
});
