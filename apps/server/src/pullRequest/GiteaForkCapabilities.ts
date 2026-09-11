import type { PullRequestCapabilities } from "@t3tools/contracts";

export function giteaForkCapabilities(
  base: PullRequestCapabilities,
  features: ReadonlyArray<string>,
): PullRequestCapabilities {
  return {
    ...base,
    fileViewedState: features.includes("pull-viewed-files"),
    actions: base.actions.filter((action) =>
      action === "approve-workflows"
        ? features.includes("actions-run-approve")
        : action === "revert"
          ? features.includes("pull-revert")
          : true,
    ),
    ...(features.includes("pull-review-reactions")
      ? { reactionSubjects: { ...base.reactionSubjects!, review: true } }
      : {}),
  };
}
