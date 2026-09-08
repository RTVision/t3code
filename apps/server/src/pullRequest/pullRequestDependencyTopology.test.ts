import { describe, expect, it } from "vite-plus/test";
import {
  PullRequestDependencyContext,
  type ProjectId,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProviderChangeRequest } from "./PullRequestProvider.ts";
import { buildPullRequestDependencyContext } from "./pullRequestDependencyTopology.ts";

const projectId = "project-1" as ProjectId;

function row(
  number: number,
  headBranch: string,
  baseBranch: string,
  headRepositoryNameWithOwner: string | null | undefined = "acme/web",
): ProviderChangeRequest {
  return {
    number,
    title: `PR ${number}`,
    url: `https://forge.test/acme/web/pulls/${number}`,
    author: null,
    headBranch,
    ...(headRepositoryNameWithOwner === undefined ? {} : { headRepositoryNameWithOwner }),
    baseBranch,
    state: "open",
    isDraft: false,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    reviewRequestLogins: [],
    labels: [],
  };
}

function context(
  rows: ReadonlyArray<ProviderChangeRequest>,
  focus = 2,
  complete = true,
  provider: SourceControlProviderKind = "github",
) {
  return buildPullRequestDependencyContext({
    projectId,
    provider,
    host: provider === "gitea" ? "gitea.example.test" : "github.com",
    repository: "acme/web",
    focus,
    rows,
    complete,
  });
}

describe("pull request dependency topology", () => {
  it("builds a qualified GitHub chain and retains sibling choices", () => {
    const result = context([
      row(1, "migration", "main"),
      row(2, "api", "migration"),
      row(3, "ui", "api"),
      row(4, "docs", "migration"),
    ]);

    expect(result.nodes.map((node) => node.ref.number).sort()).toEqual([1, 2, 3, 4]);
    expect(result.edges).toEqual([
      { child: 2, parent: 1, certainty: "confirmed" },
      { child: 3, parent: 2, certainty: "confirmed" },
      { child: 4, parent: 1, certainty: "confirmed" },
    ]);
    expect(result.coverage).toBe("complete");
  });

  it("keeps a single Gitea match candidate when the bounded listing is partial", () => {
    const result = context(
      [row(1, "migration", "main"), row(2, "api", "migration")],
      2,
      false,
      "gitea",
    );

    expect(result.edges).toEqual([{ child: 2, parent: 1, certainty: "candidate" }]);
    expect(result.coverage).toBe("partial");
  });

  it("reports partial coverage when the requested focus is absent from a complete listing", () => {
    const result = context([row(1, "migration", "main")], 2);

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.coverage).toBe("partial");
  });

  it("matches GitHub repository identity using the host's case-insensitive semantics", () => {
    const result = context([
      row(1, "migration", "main", "Acme/Web"),
      row(2, "api", "migration", "acme/web"),
    ]);

    expect(result.edges).toEqual([{ child: 2, parent: 1, certainty: "confirmed" }]);
  });

  it("never confirms an unknown repository identity and ignores a known fork", () => {
    const result = context([
      row(1, "migration", "main", null),
      row(2, "api", "migration"),
      row(9, "migration", "main", "somebody/fork"),
    ]);

    expect(result.edges).toEqual([{ child: 2, parent: 1, certainty: "candidate" }]);
    expect(result.nodes.map((node) => node.ref.number).sort()).toEqual([1, 2]);
    expect(result.issues).toContainEqual({ number: 1, reason: "identity-unknown" });
  });

  it("keeps an unavailable source as a candidate child but never as a live parent", () => {
    const unavailable = { ...row(2, "retained-head", "base-head"), headBranchAvailable: false };
    const result = context([
      row(1, "base-head", "main"),
      unavailable,
      row(3, "live-child", "retained-head"),
    ]);

    expect(result.edges).toEqual([{ child: 2, parent: 1, certainty: "candidate" }]);
    expect(result.nodes.find((node) => node.ref.number === 2)?.head).toBeNull();
    expect(result.nodes.some((node) => node.ref.number === 3)).toBe(false);
    expect(result.issues).toContainEqual({ number: 2, reason: "source-unavailable" });
    expect(result.coverage).toBe("partial");
  });

  it("does not make a known chain partial because of an unrelated unknown source identity", () => {
    const result = context([
      row(1, "migration", "main"),
      row(2, "api", "migration"),
      row(9, "unrelated", "main", null),
    ]);

    expect(result.coverage).toBe("complete");
    expect(result.issues).toEqual([]);
    expect(result.edges).toEqual([{ child: 2, parent: 1, certainty: "confirmed" }]);
  });

  it("caps oversized components to the wire schema while retaining the focus and valid endpoints", () => {
    const rows = Array.from({ length: 401 }, (_, index) =>
      row(index + 1, `branch-${index + 1}`, `branch-${index}`),
    );
    const result = context(rows, 401);
    const numbers = new Set(result.nodes.map((node) => node.ref.number));

    expect(result.nodes).toHaveLength(300);
    expect(numbers.has(401)).toBe(true);
    expect(result.edges.length).toBeGreaterThan(0);
    expect(result.edges.every((edge) => numbers.has(edge.child) && numbers.has(edge.parent))).toBe(
      true,
    );
    expect(result.edges.every((edge) => edge.certainty === "candidate")).toBe(true);
    expect(result.coverage).toBe("partial");
    expect(result.issues).toContainEqual({ reason: "budget" });
    expect(Schema.is(PullRequestDependencyContext)(result)).toBe(true);
  });

  it("retains the nearest relationships when listing order puts a direct parent last", () => {
    const rows = [
      ...Array.from({ length: 399 }, (_, index) =>
        row(index + 2, `branch-${index + 2}`, `branch-${index + 1}`),
      ),
      row(1, "branch-1", "branch-401"),
      row(401, "branch-401", "main"),
    ];
    const result = context(rows, 1);
    const numbers = new Set(result.nodes.map((node) => node.ref.number));

    expect(result.nodes).toHaveLength(300);
    expect(numbers.has(1)).toBe(true);
    expect(numbers.has(2)).toBe(true);
    expect(numbers.has(401)).toBe(true);
    expect(numbers.has(300)).toBe(false);
    expect(result.edges).toContainEqual({ child: 1, parent: 401, certainty: "candidate" });
    expect(result.coverage).toBe("partial");
    expect(result.issues).toContainEqual({ reason: "budget" });
  });

  it("discovers the nearest relationships when the focus follows the global edge budget", () => {
    const rows = Array.from({ length: 501 }, (_, index) =>
      row(index + 1, `branch-${index + 1}`, `branch-${index}`),
    );
    const result = context(rows, 501);
    const numbers = new Set(result.nodes.map((node) => node.ref.number));

    expect(result.nodes).toHaveLength(300);
    expect(numbers.has(501)).toBe(true);
    expect(numbers.has(500)).toBe(true);
    expect(result.edges).toContainEqual({ child: 501, parent: 500, certainty: "candidate" });
    expect(result.coverage).toBe("partial");
    expect(result.issues).toContainEqual({ reason: "budget" });
  });

  it("does not spend the focus edge budget on an unrelated dense component", () => {
    const unrelated = Array.from({ length: 25 }, (_, index) => row(index + 1, "shared", "shared"));
    const result = context(
      [...unrelated, row(1_001, "focus-parent", "main"), row(1_002, "focus-child", "focus-parent")],
      1_002,
    );

    expect(result.nodes.map((node) => node.ref.number)).toEqual([1_001, 1_002]);
    expect(result.edges).toEqual([{ child: 1_002, parent: 1_001, certainty: "confirmed" }]);
    expect(result.coverage).toBe("complete");
    expect(result.issues).toEqual([]);
  });

  it("exposes duplicate qualified heads as ambiguous parent choices", () => {
    const result = context([
      row(1, "migration", "main"),
      row(5, "migration", "release"),
      row(2, "api", "migration"),
    ]);

    expect(result.edges).toEqual([
      { child: 2, parent: 1, certainty: "candidate" },
      { child: 2, parent: 5, certainty: "candidate" },
    ]);
    expect(result.issues).toContainEqual({ number: 2, reason: "ambiguous-parent" });
  });

  it("downgrades cycles so they cannot masquerade as an ordered chain", () => {
    const result = context([row(1, "one", "two"), row(2, "two", "one")]);

    expect(result.edges).toHaveLength(2);
    expect(result.edges).toEqual(
      expect.arrayContaining([
        { child: 1, parent: 2, certainty: "candidate" },
        { child: 2, parent: 1, certainty: "candidate" },
      ]),
    );
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { number: 1, reason: "cycle" },
        { number: 2, reason: "cycle" },
      ]),
    );
  });

  it("bounds dense duplicate heads before cycle analysis without confirming an omitted choice", () => {
    const rows = Array.from({ length: 200 }, (_, index) => row(index + 1, "shared", "shared"));

    const result = context(rows, 1);

    expect(result.edges).toHaveLength(400);
    expect(result.edges.every((edge) => edge.certainty === "candidate")).toBe(true);
    expect(result.coverage).toBe("partial");
    expect(result.issues).toContainEqual({ reason: "budget" });
    expect(result.issues.length).toBeLessThanOrEqual(400);
  });

  it("reports partial coverage when only the issue budget is exhausted", () => {
    const rows = Array.from({ length: 200 }, (_, index) => {
      const group = Math.floor(index / 2);
      return row(index + 1, `group-${group}`, `group-${(group + 1) % 100}`);
    });
    const result = context(rows, 1);

    expect(result.nodes).toHaveLength(200);
    expect(result.edges).toHaveLength(400);
    expect(result.issues).toHaveLength(398);
    expect(result.issues).toContainEqual({ reason: "budget" });
    expect(result.coverage).toBe("partial");
    expect(Schema.is(PullRequestDependencyContext)(result)).toBe(true);
  });
});
