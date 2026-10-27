import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useSyncExternalStore } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { filesViewedScope } from "./filesViewedStore";
import {
  countViewedFiles,
  isFileViewed,
  isStaleViewedState,
  toFileViewedStates,
} from "./pullRequestFilesViewed.logic";

export interface PullRequestFilesViewedView {
  readonly enabled: boolean;
  /** Whether this client holds the grant to record views here. */
  readonly writable: boolean;
  readonly isViewed: (path: string) => boolean;
  readonly isStale: (path: string) => boolean;
  /** False when the press was refused for lack of the grant. */
  readonly setViewed: (path: string, viewed: boolean) => boolean;
  readonly viewedCount: number;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

const NO_OVERLAY = new Map<string, boolean>();
// Without this a change request that cannot record views would still be handed a scope handle.
const DISABLED_SCOPE = {
  subscribe: () => () => {},
  getSnapshot: () => NO_OVERLAY,
  setViewed: () => {},
};

export function usePullRequestFilesViewed(options: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly enabled: boolean;
  readonly paths: ReadonlyArray<string>;
}): PullRequestFilesViewedView {
  const { environmentId, reference, enabled, paths } = options;
  const canWrite = useAtomValue(
    pullRequestEnvironment.setFilesViewed.permissionAtom(environmentId),
  );
  const writable = enabled && canWrite;
  const query = useEnvironmentQuery(
    enabled ? pullRequestEnvironment.filesViewed({ environmentId, input: reference }) : null,
  );
  const states = toFileViewedStates(query.data);
  // Stable per scope: `setViewed` is handed to every file header the viewer draws.
  const scope = enabled ? filesViewedScope({ environmentId, reference }) : DISABLED_SCOPE;
  const overlay = useSyncExternalStore(scope.subscribe, scope.getSnapshot);

  return {
    enabled,
    writable,
    isViewed: (path: string) => isFileViewed(path, states, overlay),
    isStale: (path: string) => !overlay.has(path) && isStaleViewedState(states?.get(path)),
    setViewed: (path: string, viewed: boolean) => {
      if (!writable) return false;
      scope.setViewed(path, viewed);
      return true;
    },
    viewedCount: countViewedFiles(paths, states, overlay),
    truncated: query.data?.truncated === true,
    error: query.error,
    refresh: query.refresh,
  };
}
