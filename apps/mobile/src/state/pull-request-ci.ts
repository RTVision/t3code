import { createPullRequestCiEnvironmentAtoms } from "@t3tools/client-runtime/state/pull-requests";

import { connectionAtomRuntime } from "../connection/runtime";

export const pullRequestCiEnvironment = createPullRequestCiEnvironmentAtoms(connectionAtomRuntime);
