import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { pullRequestStackView } from "./pullRequestStackSnapshot";
import type { PullRequestDependencyContext, PullRequestStack } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestDependencyNavigation,
  shouldReadInferredPullRequestRelationships,
} from "./pullRequestDependencyNavigation.logic";

function context(
  overrides: Partial<PullRequestDependencyContext> = {},
): PullRequestDependencyContext {
  return {
    focus: { projectId: "project" as never, repository: "acme/web", number: 42 },
    provider: "github",
    host: "github.com",
    repository: "acme/web",
    coverage: "complete",
    issues: [],
    nodes: [41, 42, 43, 44].map((number) => ({
      ref: { projectId: "project" as never, repository: "acme/web", number },
      title: `PR ${number}`,
      url: `https://github.com/acme/web/pull/${number}`,
      state: "open" as const,
      isDraft: false,
      baseBranch: number === 41 ? "main" : `branch-${number - 1}`,
      head: { repository: "acme/web", branch: `branch-${number}` },
    })),
    edges: [],
    ...overrides,
  };
}
const view = (value: PullRequestDependencyContext | null, pending = false) =>
  pullRequestDependencyNavigation({ supported: true, context: value, pending, failed: false });

describe("pull request dependency navigation", () => {
  it("builds confirmed linear navigation around the focused request", () => {
    const navigation = view(
      context({
        edges: [
          { parent: 41, child: 42, certainty: "confirmed" },
          { parent: 42, child: 43, certainty: "confirmed" },
        ],
      }),
    );
    expect(navigation).toMatchObject({
      status: "ready",
      path: [{ number: 41 }, { number: 42 }, { number: 43 }],
      rootBase: "main",
    });
  });
  it("keeps siblings and branch points as choices", () => {
    const navigation = view(
      context({
        edges: [
          { parent: 41, child: 42, certainty: "confirmed" },
          { parent: 41, child: 44, certainty: "confirmed" },
        ],
      }),
    );
    expect(navigation).toMatchObject({ status: "ready", siblings: [{ number: 44 }] });
  });
  it("does not turn a candidate parent into a root base or navigation", () => {
    const navigation = view(
      context({ coverage: "partial", edges: [{ parent: 41, child: 42, certainty: "candidate" }] }),
    );
    expect(navigation).toMatchObject({
      status: "ready",
      rootBase: null,
      possibleParents: [{ number: 41 }],
    });
  });
  it("keeps warnings on another retained branch out of the focused path", () => {
    const navigation = view(
      context({
        coverage: "partial",
        edges: [
          { parent: 41, child: 42, certainty: "confirmed" },
          { parent: 41, child: 43, certainty: "confirmed" },
          { parent: 44, child: 43, certainty: "candidate" },
          { parent: 43, child: 44, certainty: "candidate" },
        ],
        issues: [
          { number: 43, reason: "ambiguous-parent" },
          { number: 43, reason: "cycle" },
          { number: 44, reason: "cycle" },
        ],
      }),
    );

    expect(navigation).toMatchObject({
      status: "ready",
      path: [{ number: 41 }, { number: 42 }],
      rootBase: "main",
      parentAmbiguous: false,
      cycleBefore: false,
      cycleAfter: false,
      siblings: [{ number: 43 }],
      coverage: "partial",
    });
  });

  it.each([41, 42])("retains ambiguous-parent warnings for ancestor or focus #%s", (number) => {
    expect(
      view(
        context({
          edges: [{ parent: 41, child: 42, certainty: "confirmed" }],
          issues: [{ number, reason: "ambiguous-parent" }],
        }),
      ),
    ).toMatchObject({ status: "ready", rootBase: null, parentAmbiguous: number === 42 });
  });

  it("retains cycle warnings for nodes on the focused path", () => {
    expect(
      view(
        context({
          edges: [{ parent: 41, child: 42, certainty: "confirmed" }],
          issues: [{ number: 42, reason: "cycle" }],
        }),
      ),
    ).toMatchObject({ status: "ready", cycleAfter: true });
  });

  it("does not hide the root base for an ambiguous descendant", () => {
    expect(
      view(
        context({
          edges: [
            { parent: 41, child: 42, certainty: "confirmed" },
            { parent: 42, child: 43, certainty: "confirmed" },
          ],
          issues: [{ number: 43, reason: "ambiguous-parent" }],
        }),
      ),
    ).toMatchObject({ status: "ready", rootBase: "main", parentAmbiguous: false });
  });

  it("keeps inferred navigation visible with a warning when refresh fails", () => {
    const stale = context({ edges: [{ parent: 41, child: 42, certainty: "confirmed" }] });
    expect(
      pullRequestDependencyNavigation({
        supported: true,
        context: stale,
        pending: false,
        failed: true,
      }),
    ).toMatchObject({
      status: "ready",
      coverage: "unavailable",
      path: [{ number: 41 }, { number: 42 }],
    });
  });
  it("shows partial and unavailable empty results instead of claiming no dependencies", () => {
    expect(
      view(
        context({
          coverage: "partial",
          nodes: [42].map((number) => context().nodes.find((node) => node.ref.number === number)!),
        }),
      ),
    ).toMatchObject({ status: "partial-empty" });
    expect(view(context({ coverage: "unavailable", nodes: [] }))).toMatchObject({
      status: "unavailable",
    });
  });
  it("does not invent a root base below a candidate or cycle boundary", () => {
    const candidateRoot = view(
      context({
        focus: { projectId: "project" as never, repository: "acme/web", number: 43 },
        edges: [
          { parent: 41, child: 42, certainty: "confirmed" },
          { parent: 42, child: 43, certainty: "confirmed" },
          { parent: 44, child: 41, certainty: "candidate" },
        ],
      }),
    );
    expect(candidateRoot).toMatchObject({ status: "ready", rootBase: null });
    expect(
      view(
        context({
          issues: [{ reason: "cycle" }],
          edges: [{ parent: 41, child: 42, certainty: "confirmed" }],
        }),
      ),
    ).toMatchObject({ status: "ready", cycleAfter: true });
  });
  it("turns multiple confirmed parents into an explicit choice", () => {
    const navigation = view(
      context({
        edges: [
          { parent: 41, child: 42, certainty: "confirmed" },
          { parent: 44, child: 42, certainty: "confirmed" },
        ],
      }),
    );
    expect(navigation).toMatchObject({
      status: "ready",
      rootBase: null,
      possibleParents: [{ number: 41 }, { number: 44 }],
    });
  });
  it("withholds a root base when the host only flags an ambiguous parent", () => {
    expect(view(context({ issues: [{ reason: "ambiguous-parent" }] }))).toMatchObject({
      status: "ready",
      parentAmbiguous: true,
      rootBase: null,
      possibleParents: [],
    });
  });
  it("withholds a root base when an ancestor has multiple confirmed parents", () => {
    const navigation = view(
      context({
        edges: [
          { parent: 41, child: 42, certainty: "confirmed" },
          { parent: 40, child: 41, certainty: "confirmed" },
          { parent: 44, child: 41, certainty: "confirmed" },
        ],
      }),
    );
    expect(navigation).toMatchObject({
      status: "ready",
      path: [{ number: 41 }, { number: 42 }],
      rootBase: null,
    });
  });
  it("keeps the nearest child inside a bounded long chain", () => {
    const seed = context();
    const nodes = Array.from({ length: 27 }, (_, index) => {
      const number = index + 1;
      return {
        ...seed.nodes[0]!,
        ref: { projectId: "project" as never, repository: "acme/web", number },
        title: `PR ${number}`,
        baseBranch: number === 1 ? "main" : `branch-${number - 1}`,
      };
    });
    const edges = Array.from({ length: 26 }, (_, index) => ({
      parent: index + 1,
      child: index + 2,
      certainty: "confirmed" as const,
    }));
    const navigation = view(
      context({
        focus: { projectId: "project" as never, repository: "acme/web", number: 26 },
        nodes,
        edges,
      }),
    );
    expect(navigation).toMatchObject({
      status: "ready",
      truncatedBefore: true,
      truncatedAfter: false,
    });
    if (navigation.status !== "ready") throw new Error("expected ready navigation");
    expect(navigation.path).toHaveLength(20);
    expect(navigation.path.at(-1)?.number).toBe(27);
  });
});

describe("native stack precedence", () => {
  const lookup = {
    supported: true,
    nativeStackSupported: true,
    hasNativeStack: false,
    nativeStackSettled: true,
  };
  it("uses inference after a successful native lookup reports no stack", () => {
    expect(shouldReadInferredPullRequestRelationships(lookup)).toBe(true);
  });
  it("does not query or show inference beside fresh or saved native membership", () => {
    for (const nativeStackSettled of [true, false]) {
      expect(
        shouldReadInferredPullRequestRelationships({
          ...lookup,
          hasNativeStack: true,
          nativeStackSettled,
        }),
      ).toBe(false);
    }
  });
  it("waits for the initial native lookup before querying inference", () => {
    expect(
      shouldReadInferredPullRequestRelationships({ ...lookup, nativeStackSettled: false }),
    ).toBe(false);
  });
  it("keeps inference available on Gitea and servers without native stack support", () => {
    expect(
      shouldReadInferredPullRequestRelationships({
        ...lookup,
        nativeStackSupported: false,
        nativeStackSettled: false,
      }),
    ).toBe(true);
  });
  it("does not call the dependency RPC on older servers that omit its capability", () => {
    expect(shouldReadInferredPullRequestRelationships({ ...lookup, supported: false })).toBe(false);
  });
});

describe("inferred navigation through native refreshes", () => {
  const nativeStack: PullRequestStack = {
    id: "stack",
    number: 1,
    url: "https://github.com/acme/web/stacks/1",
    base: "main",
    layers: [{ number: 42, headBranch: "feature", state: "open" }],
  };
  function navigation(result: AsyncResult.AsyncResult<PullRequestStack | null, string>) {
    const query = {
      data: Option.getOrNull(AsyncResult.value(result)),
      isSuccess: AsyncResult.isSuccess(result),
      isPending: result.waiting,
      error: AsyncResult.isFailure(result) ? "Refresh failed" : null,
    };
    const stack = pullRequestStackView(query, null);
    return {
      nativeFresh: stack.isFresh,
      inferred: shouldReadInferredPullRequestRelationships({
        supported: true,
        nativeStackSupported: true,
        hasNativeStack: stack.data !== null,
        nativeStackSettled: query.isSuccess || query.error !== null,
      }),
    };
  }
  it("keeps inferred navigation through a pending or failed refresh of native absence", () => {
    const absent = AsyncResult.success<PullRequestStack | null>(null);
    expect(navigation(AsyncResult.initial(true)).inferred).toBe(false);
    expect(navigation(absent).inferred).toBe(true);
    expect(navigation(AsyncResult.waiting(absent))).toEqual({ nativeFresh: false, inferred: true });
    expect(
      navigation(AsyncResult.fail("Offline", { previousSuccess: Option.some(absent) })),
    ).toEqual({ nativeFresh: false, inferred: true });
  });
  it("uses read-only inference if the first native lookup fails", () => {
    expect(navigation(AsyncResult.fail("Unavailable"))).toEqual({
      nativeFresh: false,
      inferred: true,
    });
  });
  it("switches to native navigation when membership arrives and retains it through refreshes", () => {
    const present = AsyncResult.success(nativeStack);
    expect(navigation(present)).toEqual({ nativeFresh: true, inferred: false });
    expect(navigation(AsyncResult.waiting(present))).toEqual({
      nativeFresh: false,
      inferred: false,
    });
    expect(
      navigation(AsyncResult.fail("Offline", { previousSuccess: Option.some(present) })),
    ).toEqual({ nativeFresh: false, inferred: false });
  });
});
