import type { PullRequestDependencyContext, PullRequestState } from "@t3tools/contracts";

export interface DependencyChip {
  readonly number: number;
  readonly title: string | null;
  readonly state: PullRequestState | null;
  readonly isDraft: boolean;
  readonly baseBranch: string | null;
}

export type DependencyNavigation =
  | { readonly status: "hidden" }
  | { readonly status: "pending" }
  | { readonly status: "unavailable" }
  | { readonly status: "partial-empty" }
  | {
      readonly status: "ready";
      readonly path: ReadonlyArray<DependencyChip>;
      readonly focusIndex: number;
      readonly rootBase: string | null;
      readonly truncatedBefore: boolean;
      readonly truncatedAfter: boolean;
      readonly cycleBefore: boolean;
      readonly cycleAfter: boolean;
      readonly parent: number | null;
      readonly parentAmbiguous: boolean;
      readonly child: number | null;
      readonly children: ReadonlyArray<DependencyChip>;
      readonly siblings: ReadonlyArray<DependencyChip>;
      readonly possibleParents: ReadonlyArray<DependencyChip>;
      readonly possibleChildren: ReadonlyArray<DependencyChip>;
      readonly coverage: "complete" | "partial" | "unavailable";
      readonly native:
        | { readonly status: "hidden" | "unavailable" }
        | {
            readonly status: "present";
            readonly members: ReadonlyArray<DependencyChip>;
            readonly coverage: "complete" | "partial";
          };
    };

const MAX_PATH_NODES = 20;

function chipFromNode(
  node: PullRequestDependencyContext["nodes"][number] | undefined,
  number: number,
): DependencyChip {
  return node
    ? {
        number,
        title: node.title,
        state: node.state,
        isDraft: node.isDraft,
        baseBranch: node.baseBranch,
      }
    : { number, title: null, state: null, isDraft: false, baseBranch: null };
}

function unique(numbers: ReadonlyArray<number>): number | null {
  return numbers.length === 1 ? (numbers[0] ?? null) : null;
}

/** Derives bounded, confirmed navigation. Candidate edges only appear as explicit choices. */
export function pullRequestDependencyNavigation(input: {
  readonly supported: boolean;
  readonly context: PullRequestDependencyContext | null;
  readonly pending: boolean;
  readonly failed: boolean;
}): DependencyNavigation {
  if (!input.supported) return { status: "hidden" };
  if (input.context === null)
    return input.pending ? { status: "pending" } : { status: "unavailable" };
  const context = input.context;
  const byNumber = new Map(context.nodes.map((node) => [node.ref.number, node]));
  const focus = context.focus.number;
  const incoming = new Map<number, number[]>();
  const outgoing = new Map<number, number[]>();
  const candidateIncoming = new Map<number, number[]>();
  const candidateOutgoing = new Map<number, number[]>();
  for (const edge of context.edges) {
    const target = edge.certainty === "confirmed" ? incoming : candidateIncoming;
    target.set(edge.child, [...(target.get(edge.child) ?? []), edge.parent]);
    const reverse = edge.certainty === "confirmed" ? outgoing : candidateOutgoing;
    reverse.set(edge.parent, [...(reverse.get(edge.parent) ?? []), edge.child]);
  }
  const toChips = (numbers: ReadonlyArray<number>) =>
    numbers.map((number) => chipFromNode(byNumber.get(number), number));
  const confirmedParents = incoming.get(focus) ?? [];
  const parent = unique(confirmedParents);
  const child = unique(outgoing.get(focus) ?? []);
  const parentAmbiguous = context.issues.some((issue) => issue.reason === "ambiguous-parent");
  const possibleParents = toChips([
    ...new Set([
      ...(confirmedParents.length > 1 ? confirmedParents : []),
      ...(candidateIncoming.get(focus) ?? []),
    ]),
  ]);
  const possibleChildren = toChips(candidateOutgoing.get(focus) ?? []);
  const ancestors: DependencyChip[] = [];
  const descendants: DependencyChip[] = [];
  let truncatedBefore = false;
  let truncatedAfter = false;
  let cycleBefore = false;
  let cycleAfter = false;
  const beforeSeen = new Set<number>([focus]);
  let before = parent;
  while (before !== null) {
    if (beforeSeen.has(before)) {
      cycleBefore = true;
      break;
    }
    if (ancestors.length >= MAX_PATH_NODES - 1) {
      truncatedBefore = true;
      break;
    }
    beforeSeen.add(before);
    ancestors.unshift(chipFromNode(byNumber.get(before), before));
    before = unique(incoming.get(before) ?? []);
  }
  const afterSeen = new Set<number>(beforeSeen);
  let after = child;
  while (after !== null) {
    if (afterSeen.has(after)) {
      cycleAfter = true;
      break;
    }
    if (descendants.length >= MAX_PATH_NODES - 1) {
      truncatedAfter = true;
      break;
    }
    afterSeen.add(after);
    descendants.push(chipFromNode(byNumber.get(after), after));
    after = unique(outgoing.get(after) ?? []);
  }
  const budget = MAX_PATH_NODES - 1;
  const keepBefore = Math.min(
    ancestors.length,
    Math.max(Math.floor(budget / 2), budget - descendants.length),
  );
  const keepAfter = Math.min(descendants.length, budget - keepBefore);
  truncatedBefore ||= keepBefore < ancestors.length;
  truncatedAfter ||= keepAfter < descendants.length;
  const keptAncestors = ancestors.slice(ancestors.length - keepBefore);
  const keptDescendants = descendants.slice(0, keepAfter);
  const path = [...keptAncestors, chipFromNode(byNumber.get(focus), focus), ...keptDescendants];
  const pathEnd = path.at(-1)?.number ?? focus;
  const unresolvedRoot =
    truncatedBefore ||
    cycleBefore ||
    (candidateIncoming.get(path[0]?.number ?? focus)?.length ?? 0) > 0 ||
    (incoming.get(path[0]?.number ?? focus)?.length ?? 0) > 1 ||
    context.coverage === "unavailable";
  const endChildren = outgoing.get(pathEnd) ?? [];
  const children = endChildren.length > 1 ? toChips(endChildren) : [];
  const siblings =
    parent === null ? [] : toChips((outgoing.get(parent) ?? []).filter((n) => n !== focus));
  const native =
    context.native?.status === "present"
      ? {
          status: "present" as const,
          members: toChips(context.native.members),
          coverage: context.native.coverage,
        }
      : context.native?.status === "unavailable"
        ? { status: "unavailable" as const }
        : { status: "hidden" as const };
  // The transport intentionally records only that a cycle was found, not an invented direction.
  // When traversal did not encounter it itself, place the stop after the known path.
  if (context.issues.some((issue) => issue.reason === "cycle") && !cycleBefore && !cycleAfter) {
    cycleAfter = true;
  }
  const hasGraph =
    keptAncestors.length > 0 ||
    keptDescendants.length > 0 ||
    children.length > 0 ||
    siblings.length > 0 ||
    possibleParents.length > 0 ||
    possibleChildren.length > 0 ||
    truncatedBefore ||
    truncatedAfter ||
    cycleBefore ||
    cycleAfter ||
    parentAmbiguous;
  const hasNative = native.status !== "hidden";
  const unavailable =
    context.coverage === "unavailable" ||
    context.issues.some((issue) => issue.reason === "host-unavailable");
  if (!hasGraph && !hasNative) {
    if (unavailable || input.failed) return { status: "unavailable" };
    return context.coverage === "partial" ||
      context.issues.some((issue) => issue.reason === "budget")
      ? { status: "partial-empty" }
      : { status: "hidden" };
  }
  return {
    status: "ready",
    path,
    focusIndex: keptAncestors.length,
    rootBase:
      possibleParents.length > 0 || parentAmbiguous || unresolvedRoot
        ? null
        : (path[0]?.baseBranch ?? null),
    truncatedBefore,
    truncatedAfter,
    cycleBefore,
    cycleAfter,
    parent,
    parentAmbiguous,
    child,
    children,
    siblings,
    possibleParents,
    possibleChildren,
    coverage: context.coverage,
    native,
  };
}
