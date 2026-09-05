import type { PullRequestDependencyContext } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestDependencyNavigation } from "./pullRequestDependencyNavigation.logic";

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
      focusIndex: 1,
      parent: 41,
      child: 43,
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
    expect(navigation).toMatchObject({ status: "ready", child: null, siblings: [{ number: 44 }] });
  });
  it("does not turn a candidate parent into a root base or navigation", () => {
    const navigation = view(
      context({ coverage: "partial", edges: [{ parent: 41, child: 42, certainty: "candidate" }] }),
    );
    expect(navigation).toMatchObject({
      status: "ready",
      rootBase: null,
      parent: null,
      possibleParents: [{ number: 41 }],
    });
  });
  it("keeps native membership navigable when a member was not loaded", () => {
    const navigation = view(
      context({
        nodes: [],
        native: { status: "present", id: "stack", members: [40, 42], coverage: "partial" },
      }),
    );
    expect(navigation).toMatchObject({
      status: "ready",
      native: {
        status: "present",
        members: [
          { number: 40, title: null },
          { number: 42, title: null },
        ],
      },
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
  it("keeps native membership visible when branch relationship coverage is unavailable", () => {
    const navigation = view(
      context({
        coverage: "unavailable",
        nodes: [],
        native: { status: "present", id: "stack", members: [40, 42], coverage: "complete" },
      }),
    );
    expect(navigation).toMatchObject({
      status: "ready",
      coverage: "unavailable",
      rootBase: null,
      native: { status: "present" },
    });
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
      parent: null,
      rootBase: null,
      possibleParents: [{ number: 41 }, { number: 44 }],
    });
  });
  it("withholds a root base when the host only flags an ambiguous parent", () => {
    expect(view(context({ issues: [{ reason: "ambiguous-parent" }] }))).toMatchObject({
      status: "ready",
      parent: null,
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
