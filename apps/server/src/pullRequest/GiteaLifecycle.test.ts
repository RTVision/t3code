import { describe, expect, it } from "@effect/vitest";

import {
  autoMergeEnabled,
  titleForDraft,
  titleForDraftAction,
  titleForReady,
} from "./GiteaLifecycle.ts";

describe("Gitea draft titles", () => {
  it("uses the configured first prefix and does not stack an existing prefix", () => {
    expect(titleForDraft("Ship it", ["Draft:", "[Draft]"])).toBe("Draft: Ship it");
    expect(titleForDraft("draft: Ship it", ["Draft:", "[Draft]"])).toBe("draft: Ship it");
  });

  it("removes the exact configured prefix case-insensitively", () => {
    expect(titleForReady("RFC:   Ship it", ["RFC:"])).toBe("Ship it");
    expect(titleForReady("rfc: Ship it", ["RFC:"])).toBe("Ship it");
    expect(titleForReady("Draft: Ship it", ["WIP:", "[WIP]"])).toBeNull();
  });

  it("does not produce a blank ready title", () => {
    expect(titleForReady("WIP:   ", ["WIP:"])).toBeNull();
  });

  it("keeps already-satisfied lifecycle actions idempotent", () => {
    expect(
      titleForDraftAction({
        action: "draft",
        title: "WIP: Ship it",
        isDraft: true,
        prefixes: ["WIP:"],
      }),
    ).toBe("WIP: Ship it");
    expect(
      titleForDraftAction({
        action: "ready",
        title: "Ship it",
        isDraft: false,
        prefixes: ["WIP:"],
      }),
    ).toBe("Ship it");
  });
});

describe("Gitea auto-merge timeline", () => {
  it("uses the newest durable schedule, cancellation, or merge event", () => {
    expect(
      autoMergeEnabled([
        { id: 30, type: "pull_cancel_scheduled_merge" },
        { id: 10, type: "pull_scheduled_merge" },
        { id: 20, type: "comment" },
      ]),
    ).toBe(false);
    expect(
      autoMergeEnabled([
        { id: 50, type: "pull_scheduled_merge" },
        { id: 40, type: "merge_pull" },
      ]),
    ).toBe(true);
    expect(autoMergeEnabled([{ id: 60, type: "merge_pull" }])).toBe(false);
    expect(autoMergeEnabled([])).toBe(false);
  });
});
