import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";

/** Dependency numbers belong to the displayed pull request's repository, even beside another project. */
export function usePanelPullRequestNavigation(
  threadRef: ScopedThreadRef | null,
  surface: RightPanelSurface | null,
  supportsPullRequests: boolean,
) {
  return useCallback(
    (number: number) => {
      if (!supportsPullRequests || threadRef === null || surface?.kind !== "pull-request") return;
      useRightPanelStore.getState().openPullRequest(threadRef, {
        projectId: surface.projectId,
        repository: surface.repository,
        number,
      });
    },
    [threadRef, surface, supportsPullRequests],
  );
}
