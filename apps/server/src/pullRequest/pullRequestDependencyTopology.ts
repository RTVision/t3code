import type {
  ProjectId,
  PullRequestDependencyContext,
  PullRequestDependencyEdge,
  PullRequestDependencyIssue,
  SourceControlProviderKind,
} from "@t3tools/contracts";

const MAX_EDGES = 400;
const MAX_NODES = 300;
/** Leave two slots for repository-read issues added by the service. */
const MAX_TOPOLOGY_ISSUES = 398;

export interface ProviderDependencyNode {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly headBranch: string;
  readonly headBranchAvailable?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly baseBranch: string;
}

export interface PullRequestDependencyTopologyInput {
  readonly projectId: ProjectId;
  readonly provider: SourceControlProviderKind;
  readonly host: string;
  readonly repository: string;
  readonly focus: number;
  readonly rows: ReadonlyArray<ProviderDependencyNode>;
  /** Whether the unfiltered relationship listing reached the end of the host's collection. */
  readonly complete: boolean;
}

// GitHub repository names are case-insensitive. Preserve case elsewhere because a generic helper
// cannot assume the same of every self-hosted provider; adapters own any further canonicalization.
const normalizedRepository = (provider: SourceControlProviderKind, repository: string) =>
  provider === "github" ? repository.trim().toLowerCase() : repository.trim();

/**
 * Relates ordinary pull requests using only repository-qualified branch identities. The result is
 * the undirected component around the requested pull request; edge direction remains child to
 * parent so siblings stay siblings rather than being flattened into an invented order.
 */
export function buildPullRequestDependencyContext(
  input: PullRequestDependencyTopologyInput,
): PullRequestDependencyContext {
  const repository = normalizedRepository(input.provider, input.repository);
  const byNumber = new Map<number, ProviderDependencyNode>();
  for (const row of input.rows) {
    if (!byNumber.has(row.number)) byNumber.set(row.number, row);
  }

  const issues: PullRequestDependencyIssue[] = [];
  const issueKeys = new Set<string>();
  const addIssue = (issue: PullRequestDependencyIssue) => {
    const key = `${issue.number ?? "context"}:${issue.reason}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(issue);
  };
  for (const row of byNumber.values()) {
    if (row.headBranchAvailable === false)
      addIssue({ number: row.number, reason: "source-unavailable" });
  }

  const openByHeadBranch = new Map<string, ProviderDependencyNode[]>();
  const openByBaseBranch = new Map<string, ProviderDependencyNode[]>();
  const eligibleParentNumbers = new Set<number>();
  for (const row of byNumber.values()) {
    if (row.state !== "open") continue;
    const existingChildren = openByBaseBranch.get(row.baseBranch);
    if (existingChildren === undefined) openByBaseBranch.set(row.baseBranch, [row]);
    else existingChildren.push(row);
    if (row.headBranchAvailable === false) continue;
    if (
      row.headRepositoryNameWithOwner != null &&
      normalizedRepository(input.provider, row.headRepositoryNameWithOwner) !== repository
    ) {
      continue;
    }
    const existing = openByHeadBranch.get(row.headBranch);
    if (existing === undefined) openByHeadBranch.set(row.headBranch, [row]);
    else existing.push(row);
    eligibleParentNumbers.add(row.number);
  }

  const edges: PullRequestDependencyEdge[] = [];
  const edgeKeys = new Set<string>();
  const queuedNumbers = new Set<number>([input.focus]);
  const pendingNumbers = [input.focus];
  let edgeBudgetExhausted = false;
  const candidateParentCount = (child: ProviderDependencyNode) =>
    (openByHeadBranch.get(child.baseBranch)?.length ?? 0) -
    (eligibleParentNumbers.has(child.number) && child.headBranch === child.baseBranch ? 1 : 0);
  const enqueue = (number: number) => {
    if (queuedNumbers.has(number)) return;
    queuedNumbers.add(number);
    pendingNumbers.push(number);
  };
  const addEdge = (child: ProviderDependencyNode, parent: ProviderDependencyNode) => {
    const key = `${child.number}:${parent.number}`;
    if (edgeKeys.has(key)) return true;
    if (edges.length === MAX_EDGES) {
      edgeBudgetExhausted = true;
      return false;
    }
    edgeKeys.add(key);
    const ambiguous = candidateParentCount(child) > 1;
    if (ambiguous) addIssue({ number: child.number, reason: "ambiguous-parent" });
    const identityKnown = parent.headRepositoryNameWithOwner != null;
    if (!identityKnown) addIssue({ number: parent.number, reason: "identity-unknown" });
    edges.push({
      child: child.number,
      parent: parent.number,
      certainty:
        input.complete && !ambiguous && identityKnown && child.headBranchAvailable !== false
          ? "confirmed"
          : "candidate",
    });
    enqueue(child.number);
    enqueue(parent.number);
    return true;
  };

  edgeTraversal: for (let index = 0; index < pendingNumbers.length; index += 1) {
    const row = byNumber.get(pendingNumbers[index]!);
    if (row === undefined) continue;
    if (row.state === "open") {
      for (const parent of openByHeadBranch.get(row.baseBranch) ?? []) {
        if (parent.number === row.number) continue;
        if (!addEdge(row, parent)) break edgeTraversal;
      }
    }
    if (eligibleParentNumbers.has(row.number)) {
      for (const child of openByBaseBranch.get(row.headBranch) ?? []) {
        if (child.number === row.number) continue;
        if (!addEdge(child, row)) break edgeTraversal;
      }
    }
  }

  // A capped topology omits known relationships, so no retained edge may drive definitive ordering.
  if (edgeBudgetExhausted) {
    for (let index = 0; index < edges.length; index += 1) {
      edges[index] = { ...edges[index]!, certainty: "candidate" };
    }
    addIssue({ reason: "budget" });
  }

  const parentsByChild = new Map<number, number[]>();
  for (const edge of edges) {
    const parents = parentsByChild.get(edge.child);
    if (parents === undefined) parentsByChild.set(edge.child, [edge.parent]);
    else parents.push(edge.parent);
  }
  // Tarjan's strongly connected components keep cycle detection linear in the retained graph.
  // The edge cap above is therefore also a CPU bound, even for hundreds of duplicate heads.
  let nextIndex = 0;
  const indices = new Map<number, number>();
  const lowLinks = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  const componentByNumber = new Map<number, number>();
  const componentSizes: number[] = [];
  const visit = (number: number) => {
    const index = nextIndex++;
    indices.set(number, index);
    lowLinks.set(number, index);
    stack.push(number);
    onStack.add(number);
    for (const parent of parentsByChild.get(number) ?? []) {
      if (!indices.has(parent)) {
        visit(parent);
        lowLinks.set(number, Math.min(lowLinks.get(number)!, lowLinks.get(parent)!));
      } else if (onStack.has(parent)) {
        lowLinks.set(number, Math.min(lowLinks.get(number)!, indices.get(parent)!));
      }
    }
    if (lowLinks.get(number) !== indices.get(number)) return;
    const component = componentSizes.length;
    let size = 0;
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      componentByNumber.set(member, component);
      size += 1;
      if (member === number) break;
    }
    componentSizes.push(size);
  };
  for (const edge of edges) {
    if (!indices.has(edge.child)) visit(edge.child);
    if (!indices.has(edge.parent)) visit(edge.parent);
  }
  const cycleEdges = new Set<number>();
  edges.forEach((edge, index) => {
    const component = componentByNumber.get(edge.child);
    if (
      component === undefined ||
      component !== componentByNumber.get(edge.parent) ||
      componentSizes[component] === 1
    ) {
      return;
    }
    cycleEdges.add(index);
    addIssue({ number: edge.child, reason: "cycle" });
    addIssue({ number: edge.parent, reason: "cycle" });
  });
  const safeEdges = edges.map((edge, index) =>
    cycleEdges.has(index) ? { ...edge, certainty: "candidate" as const } : edge,
  );

  const neighborsByNumber = new Map<number, number[]>();
  for (const edge of safeEdges) {
    const childNeighbors = neighborsByNumber.get(edge.child) ?? [];
    childNeighbors.push(edge.parent);
    neighborsByNumber.set(edge.child, childNeighbors);
    const parentNeighbors = neighborsByNumber.get(edge.parent) ?? [];
    parentNeighbors.push(edge.child);
    neighborsByNumber.set(edge.parent, parentNeighbors);
  }
  const connected = new Set<number>([input.focus]);
  const nearestFirst = [input.focus];
  for (let index = 0; index < nearestFirst.length; index += 1) {
    for (const neighbor of neighborsByNumber.get(nearestFirst[index]!) ?? []) {
      if (!connected.has(neighbor)) {
        connected.add(neighbor);
        nearestFirst.push(neighbor);
      }
    }
  }

  // Breadth-first order keeps the selected pull request and its nearest relationships when capped.
  const retained = new Set(nearestFirst.slice(0, MAX_NODES));
  const nodeBudgetExhausted = retained.size < connected.size;
  const componentEdges = safeEdges
    .filter((edge) => retained.has(edge.child) && retained.has(edge.parent))
    .map((edge) => (nodeBudgetExhausted ? { ...edge, certainty: "candidate" as const } : edge));
  if (nodeBudgetExhausted) addIssue({ reason: "budget" });

  let componentIssues = issues.filter(
    (issue) => issue.number === undefined || retained.has(issue.number),
  );
  const hasUnknownIdentity = [...byNumber.values()].some(
    (row) => connected.has(row.number) && row.headRepositoryNameWithOwner == null,
  );
  const hasUnavailableSource = [...byNumber.values()].some(
    (row) => row.headBranchAvailable === false,
  );
  if (hasUnknownIdentity && !componentIssues.some((issue) => issue.reason === "identity-unknown")) {
    componentIssues.push({ reason: "identity-unknown" });
  }
  if (
    hasUnavailableSource &&
    !componentIssues.some((issue) => issue.reason === "source-unavailable")
  ) {
    componentIssues.push({ reason: "source-unavailable" });
  }
  const issueBudgetExhausted = componentIssues.length > MAX_TOPOLOGY_ISSUES;
  if (issueBudgetExhausted) {
    componentIssues = componentIssues.slice(0, MAX_TOPOLOGY_ISSUES - 1);
    if (!componentIssues.some((issue) => issue.reason === "budget")) {
      componentIssues.push({ reason: "budget" });
    }
  }

  return {
    focus: {
      projectId: input.projectId,
      repository: input.repository,
      number: input.focus,
    },
    provider: input.provider,
    host: input.host,
    repository: input.repository,
    nodes: [...byNumber.values()]
      .filter((row) => retained.has(row.number))
      .map((row) => ({
        ref: {
          projectId: input.projectId,
          repository: input.repository,
          number: row.number,
        },
        title: row.title,
        url: row.url,
        state: row.state,
        isDraft: row.isDraft,
        baseBranch: row.baseBranch,
        head:
          row.headRepositoryNameWithOwner == null || row.headBranchAvailable === false
            ? null
            : { repository: row.headRepositoryNameWithOwner, branch: row.headBranch },
      })),
    edges: componentEdges,
    coverage:
      input.complete &&
      byNumber.has(input.focus) &&
      !hasUnknownIdentity &&
      !hasUnavailableSource &&
      !edgeBudgetExhausted &&
      !nodeBudgetExhausted &&
      !issueBudgetExhausted
        ? "complete"
        : "partial",
    issues: componentIssues,
  };
}
