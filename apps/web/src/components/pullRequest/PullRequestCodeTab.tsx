import type { CodeViewItem, DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type { CodeViewAnnotationArgs } from "@pierre/diffs/react";
import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestDiffSide,
  PullRequestDiffResult,
  PullRequestOmittedFileStat,
  PullRequestRef,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
} from "@t3tools/contracts";
import { pullRequestCanReact } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  FolderTreeIcon,
  InfoIcon,
  MessageSquareOffIcon,
  PilcrowIcon,
  Rows3Icon,
  Settings2Icon,
  TextWrapIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { RegistryContext, useAtomRefresh } from "@effect/atom-react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide";
import * as Schema from "effect/Schema";
import {
  createContext,
  use,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { observeIntersection } from "~/lib/observeIntersection";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { areAllDiffFilesCollapsed } from "~/lib/diffCollapse";
import { pullRequestFindingKey, type PullRequestFinding } from "./pullRequestDetail.logic";
import {
  canEditPullRequestComment,
  canResolvePullRequestThread,
} from "@t3tools/client-runtime/pull-request-editing";
import { orderDiffFiles } from "./pullRequestFileOrder.logic";
import {
  buildFileDiffRenderKey,
  fnv1a32,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
  type RenderablePatch,
} from "~/lib/diffRendering";
import { APP_BASE_NAME } from "~/branding";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { createPullRequestDiffFileContentsLoader } from "~/lib/diffFileContents";
import {
  buildDiffReviewComment,
  resolveDiffReviewAnchor,
  type ReviewCommentContext,
} from "~/reviewCommentContext";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { useDiffWorkerPool } from "../DiffWorkerPoolProvider";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import { DiffFileTree } from "../diffs/DiffFileTree";
import { useCodeViewFileReveal } from "../diffs/useCodeViewFileReveal";
import { diffFileTreeEntries } from "../diffs/diffFileTree.logic";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getReviewPositionAnchor,
  PendingReviewCommentCard,
  ReviewThreadCard,
  toViewerSide,
} from "./PullRequestReviewAnnotation";
import {
  getFileViewedRange,
  isFileDiffCollapsed,
  isLineInFileDiff,
  foldChoicesAfterViewed,
  type DiffFoldChoices,
  type DiffFoldOverride,
} from "./pullRequestDiff.logic";
import { PullRequestDiffStat, PullRequestMetaLine } from "./pullRequestPresentation";
import { PullRequestDiffUnavailableState } from "./PullRequestDiffUnavailableState";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import {
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";

interface ReviewAnnotationGroup {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly draft: boolean;
}

type ReviewAnnotation = DiffLineAnnotation<ReviewAnnotationGroup>;

const COMMIT_PAGE_SIZE = 10;

const PULL_REQUEST_FILE_TREE_STORAGE_KEY = "t3code.pullRequestFileTreeOpen";

interface DiffSlice {
  readonly source: PullRequestDiffResult;
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

interface DiffSliceState {
  readonly key: string;
  readonly cursor: string | null;
  readonly slices: ReadonlyArray<DiffSlice>;
  readonly revalidating: boolean;
}

// Show host counts outside the shadow root; hunk totals are zero when hosts withhold hunks.
const REPLACE_FILE_COUNTS_CSS = `
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none !important;
}`;

const NO_SLICES: ReadonlyArray<DiffSlice> = [];

interface FileViewedToggleState {
  readonly enabled: boolean;
  readonly writable: boolean;
  readonly isViewed: (path: string) => boolean;
  readonly isStale: (path: string) => boolean;
  readonly setFileViewed: (path: string, viewed: boolean, event: Event) => void;
}

// Header portals are memoized on the render props; the viewed toggle reads its state through
// context so a press redraws the toggles, not every header on screen.
const FileViewedToggleContext = createContext<FileViewedToggleState | null>(null);

function FileViewedToggle({ path, stat }: { readonly path: string; readonly stat: ReactNode }) {
  const viewedFiles = use(FileViewedToggleContext);
  if (viewedFiles === null || !viewedFiles.enabled) return stat;
  const viewed = viewedFiles.isViewed(path);
  const stale = viewedFiles.isStale(path);
  return (
    <span className="flex items-center gap-3">
      {stat}
      <label
        data-viewed-toggle=""
        className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          aria-label={stale ? "Changed" : "Viewed"}
          checked={viewed}
          disabled={!viewedFiles.writable}
          onCheckedChange={(next, { event }) =>
            viewedFiles.setFileViewed(path, next === true, event)
          }
        />
        {stale ? (
          <Tooltip>
            <TooltipTrigger render={<span className="text-warning-foreground" />}>
              Changed
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              This file has been pushed to since you marked it viewed.
            </TooltipPopup>
          </Tooltip>
        ) : (
          <span className="@max-xs:hidden">Viewed</span>
        )}
      </label>
    </span>
  );
}

interface MutableAnnotationGroup {
  readonly side: PullRequestDiffSide;
  readonly line: number;
  readonly threads: PullRequestReviewThread[];
  readonly pending: PendingReviewComment[];
  draft: boolean;
}
interface DraftAnchor {
  readonly fileKey: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly position: PullRequestReviewPosition;
  readonly startPosition?: PullRequestReviewPosition;
  readonly range: SelectedLineRange;
}
export interface PullRequestAgentSelectionInput {
  readonly comment: ReviewCommentContext;
  readonly request: string;
}
/**
 * Whether a press came from the file header pinned to the top of the viewer, which is where a
 * header sits while its file runs on past the top edge. The header lives in the viewer's shadow
 * tree, so it is found through `composedPath`, which only answers while the event dispatches.
 */
function isPinnedHeaderEvent(event: Event, frame: HTMLElement | null): boolean {
  if (frame === null) return false;
  const header = event
    .composedPath()
    .find((node) => node instanceof HTMLElement && node.hasAttribute("data-diffs-header"));
  if (!(header instanceof HTMLElement)) return false;
  return header.getBoundingClientRect().top <= frame.getBoundingClientRect().top + 1;
}
/**
 * Whether the viewer draws this line at all. A line counts the new file on the right and the old
 * one on the left, and each hunk covers one run of each; a line outside every run — a
 * conversation the host could not mark outdated, or one under a hunk it withheld — has no row to
 * be pinned to, however much its file looks like a match.
 */
/**
 * The pull request's patch, with the review written against it. Conversations already on the
 * host sit under the line they were written on, and a new comment joins the review being
 * drafted rather than being posted as it is typed.
 */
function PullRequestCodeTab({
  scrollerRef,
  environmentId,
  reference,
  detail,
  selectedCommitOid,
  onSelectedCommitChange,
  pendingFinding,
  fixFindingLabel = "Fix in a thread",
  onFixFinding,
  onAddToAgentSelection,
  onRefresh,
  refreshToken = 0,
  revalidateToken = 0,
  revealRequest = null,
}: {
  scrollerRef: (node: HTMLDivElement | null) => void;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  selectedCommitOid: string | null;
  onSelectedCommitChange: (oid: string | null) => void;
  pendingFinding?: string | null;
  fixFindingLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
  onAddToAgentSelection?: (input: PullRequestAgentSelectionInput) => void;
  onRefresh: () => void;
  refreshToken?: number;
  /** Bumped when the pull request reports a new revision: re-read the loaded pages in place. */
  revalidateToken?: number;
  /** A file another tab asked to show. A new nonce asks again for the same path. */
  revealRequest?: {
    readonly path: string;
    readonly nonce: number;
  } | null;
}) {
  const resolvedTheme = useRenderedAppearance();
  // Initialize the shared tokenizer and workers while the diff request is still pending.
  useDiffWorkerPool();
  const settings = useClientSettings((settings) => ({
    diffFilesCollapsed: settings.diffFilesCollapsed,
    diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
    diffLayout: settings.diffLayout,
    wordWrap: settings.wordWrap,
  }));
  const [foldChoices, setFoldChoices] = useState<DiffFoldChoices>(() => new Map());
  const [lastViewedPath, setLastViewedPath] = useState<string | null>(null);
  const [visibleCommitCount, setVisibleCommitCount] = useState(COMMIT_PAGE_SIZE);
  const [foldOverride, setFoldOverride] = useState<DiffFoldOverride>(null);
  // An expanded default still folds what has been ticked off; only the toolbar opens everything.
  const effectiveFoldOverride = foldOverride ?? (settings.diffFilesCollapsed ? "folded" : null);
  const diffLayout = settings.diffLayout;
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    PULL_REQUEST_FILE_TREE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<DraftAnchor | null>(null);
  const [threadPending, setThreadPending] = useState(false);
  const [orphansOpen, setOrphansOpen] = useState(false);
  // Which pull request the slices belong to travels with them, so a render taken before the
  // reset below cannot read the previous one's slices — or send its cursor to the host.
  const [sliceState, setSliceState] = useState<DiffSliceState>({
    key: "",
    cursor: null,
    slices: NO_SLICES,
    revalidating: false,
  });
  const [parseCache] = useState(() => new Map<string, RenderablePatch>());
  const referenceKey = pullRequestReviewKey(reference);
  // A commit opened from the timeline or left selected across a force-push may no longer be
  // part of the pull request; read it as "All commits" instead of requesting its diff.
  const commit =
    selectedCommitOid !== null && detail.commits.some((entry) => entry.oid === selectedCommitOid)
      ? selectedCommitOid
      : null;
  const scopeKey = JSON.stringify([environmentId, referenceKey, commit]);
  // The panel keeps this mounted across pull requests, so an open composer would otherwise
  // survive the switch and attach its comment to whichever one is on screen when it is sent.
  const [previousScopeKey, setPreviousScopeKey] = useState(scopeKey);
  if (previousScopeKey !== scopeKey) {
    setPreviousScopeKey(scopeKey);
    setLastViewedPath(null);
    setDraft(null);
    setSelectedLines(null);
    setFoldChoices(new Map());
    setFoldOverride(null);
    setVisibleCommitCount(COMMIT_PAGE_SIZE);
    setOrphansOpen(false);
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES, revalidating: false });
    parseCache.clear();
  }
  const loadedSlices = sliceState.key === scopeKey ? sliceState.slices : NO_SLICES;
  const cursor = sliceState.key === scopeKey ? sliceState.cursor : null;
  const diffQuery = useEnvironmentQuery(
    pullRequestEnvironment.diff({
      environmentId,
      input: {
        ...reference,
        ...(cursor === null ? {} : { cursor }),
        ...(commit === null ? {} : { commit }),
      },
    }),
  );
  const data = diffQuery.data;
  const settled = !diffQuery.isPending && diffQuery.error === null;
  const [appliedPage, setAppliedPage] = useState<{
    data: typeof data;
    cursor: string | null;
    scopeKey: string;
    settled: boolean;
  } | null>(null);
  if (
    data !== null &&
    (appliedPage?.data !== data ||
      appliedPage.cursor !== cursor ||
      appliedPage.scopeKey !== scopeKey ||
      appliedPage.settled !== settled)
  ) {
    setAppliedPage({ data, cursor, scopeKey, settled });
    setSliceState((previous) => {
      const slices = previous.key === scopeKey ? previous.slices : NO_SLICES;
      const next = {
        source: data,
        cursor,
        patch: data.patch,
        truncated: data.truncated,
        nextCursor: data.nextCursor,
        omittedFileStats: data.omittedFileStats ?? [],
      };
      const index = slices.findIndex((slice) => slice.cursor === cursor);
      if (index === -1) {
        return { key: scopeKey, cursor, slices: [...slices, next], revalidating: false };
      }
      const existing = slices[index];
      if (
        existing !== undefined &&
        existing.patch === next.patch &&
        existing.truncated === next.truncated &&
        existing.nextCursor === next.nextCursor &&
        existing.omittedFileStats.length === next.omittedFileStats.length &&
        existing.omittedFileStats.every((file, index) => {
          const refreshed = next.omittedFileStats[index];
          return (
            refreshed !== undefined &&
            refreshed.path === file.path &&
            refreshed.additions === file.additions &&
            refreshed.deletions === file.deletions
          );
        })
      ) {
        return previous;
      }
      // Drop later slices when replacing a changed page; their cursors target the old diff.
      return {
        key: scopeKey,
        cursor,
        slices: [...slices.slice(0, index), next],
        revalidating: false,
      };
    });
  }
  // The refresh button rereads from the first page rather than the page the reader is on:
  // pages are positions in one snapshot of the diff, and a fresh snapshot starts over.
  const refreshFirstDiffPage = useAtomRefresh(
    pullRequestEnvironment.diff({
      environmentId,
      input: {
        ...reference,
        ...(commit === null ? {} : { commit }),
      },
    }),
  );
  const reviewKey = referenceKey;
  const pendingComments = usePendingReviewComments(reference);
  const addComment = usePullRequestReviewStore((store) => store.addComment);
  const removeComment = usePullRequestReviewStore((store) => store.removeComment);
  const updatePendingComment = usePullRequestReviewStore((store) => store.updateComment);
  const replyToThread = useAtomCommand(pullRequestEnvironment.replyToThread, {
    reportFailure: false,
  });
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  const updateComment = useAtomCommand(pullRequestEnvironment.updateComment, {
    reportFailure: false,
  });
  const loadThreadComments = useAtomCommand(pullRequestEnvironment.threadComments, {
    reportFailure: false,
  });
  const getDiffFileContents = useAtomCommand(pullRequestEnvironment.diffFileContents, {
    reportFailure: false,
  });
  const loadDiffFiles = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
    environmentId,
    reference,
    commit,
    cacheKey: `pull-request:${referenceKey}:${detail.updatedAt}:${commit ?? "all"}`,
  });
  const review = (() => {
    const hostReview = detail.capabilities.review;
    const viewer = detail.viewerPermissions;
    return {
      inlineComment: hostReview.inlineComment && viewer.comment,
      reply: hostReview.reply && viewer.comment,
      resolve: hostReview.resolve && viewer.resolve,
    };
  })();
  const rangeComments = detail.capabilities.review.rangeComment === true;
  // Every slice is parsed on its own and the result held, so a slice arriving costs one parse
  // rather than one per slice already on screen. Its cache key carries the theme, which is what
  // the tokenizer caches against, so a theme change is still a fresh parse.
  const parsedSlices = loadedSlices.map((slice) => {
    // The patch's own hash is part of the key: a refreshed page reuses its cursor, and a
    // key of position alone would keep handing back the parse of the patch it replaced.
    const cacheKey = `pull-request:${scopeKey}:${resolvedTheme}:${ignoreWhitespace}:${slice.cursor ?? "first"}:${fnv1a32(slice.patch)}`;
    const cached = parseCache.get(cacheKey);
    if (cached) return cached;
    const parsed = getRenderablePatch(slice.patch, cacheKey, {
      compactPartialHunkOffsets: true,
      ignoreWhitespace,
    });
    if (parsed) parseCache.set(cacheKey, parsed);
    return parsed;
  });
  const files = parsedSlices.flatMap((parsed) =>
    parsed?.kind === "files" ? orderDiffFiles(parsed.files) : [],
  );
  // A comment is posted against the pull request's head diff, so a line number taken from one
  // commit's own diff would land somewhere else entirely. Commenting waits for the whole change.
  const canCommentOnLines = review.inlineComment && commit === null;
  const canSelectLines =
    commit === null && (review.inlineComment || onAddToAgentSelection !== undefined);
  const filePaths = files.map((file) => resolveFileDiffPath(file));
  const viewedFilesStore = detail.capabilities.viewedFiles;
  const filesViewed = usePullRequestFilesViewed({
    environmentId,
    reference,
    enabled: viewedFilesStore !== undefined,
    paths: filePaths,
  });
  const {
    setViewed,
    refresh: refreshFilesViewed,
    enabled: filesViewedEnabled,
    writable: filesViewedWritable,
    isViewed: isFileViewed,
    isStale: isFileViewedStale,
  } = filesViewed;
  const appliedRefreshToken = useRef(refreshToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new refresh token clears loaded slices and refetches the first diff page and viewed files
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) return;
    appliedRefreshToken.current = refreshToken;
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES, revalidating: false });
    // An equal refetch still needs to refill the reset slices.
    setAppliedPage(null);
    refreshFirstDiffPage();
    refreshFilesViewed();
  }, [refreshToken, scopeKey, refreshFirstDiffPage, refreshFilesViewed]);
  // A new revision of the pull request walks the pages already on screen from the first, and
  // the answer for each is compared against the page it would replace (above). One that only
  // moved the conversation leaves the diff, and the reader's place in it, as it was.
  const registry = useContext(RegistryContext);
  const appliedRevalidateToken = useRef(revalidateToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes loaded diff pages after the pull request revision changes
  useEffect(() => {
    if (appliedRevalidateToken.current === revalidateToken) return;
    appliedRevalidateToken.current = revalidateToken;
    // The page being read goes too, so a first read still out when the revision moved is asked
    // again rather than landing with the older answer.
    const cursors = new Set([...loadedSlices.map((slice) => slice.cursor), cursor]);
    for (const pageCursor of cursors) {
      registry.refresh(
        pullRequestEnvironment.diff({
          environmentId,
          input: {
            ...reference,
            ...(pageCursor === null ? {} : { cursor: pageCursor }),
            ...(commit === null ? {} : { commit }),
          },
        }),
      );
    }
    // A push can have left a ticked file standing against an older version of it.
    refreshFilesViewed();
    setSliceState((previous) =>
      previous.key !== scopeKey || previous.slices.length === 0
        ? previous
        : { ...previous, cursor: null, revalidating: true },
    );
  }, [
    commit,
    cursor,
    environmentId,
    loadedSlices,
    reference,
    refreshFilesViewed,
    registry,
    revalidateToken,
    scopeKey,
  ]);
  const nextCursor = loadedSlices.at(-1)?.nextCursor ?? null;
  const revalidating = sliceState.key === scopeKey && sliceState.revalidating;
  // What a slice withheld: the host declining to inline part of it, or a patch the viewer could
  // not structure and so dropped. Neither says anything about there being more to fetch.
  const withheldContent =
    loadedSlices.some((slice) => slice.truncated) ||
    parsedSlices.some((parsed) => parsed?.kind === "raw");
  // Placing a conversation takes more than its file being in the diff: its line has to fall
  // inside a hunk that was rendered. One that does not is drawn nowhere, so it belongs in the
  // off-diff list rather than disappearing between the two.
  const placedThreadIds = (() => {
    const placed = new Set<string>();
    // A commit's diff counts lines within that commit; a review comment is anchored to the
    // pull request's head diff. Pinning one onto the other would put the remark against
    // whichever code happens to hold that line number in this commit, so while a commit is on
    // screen every conversation is listed rather than placed.
    if (commit !== null) return placed;
    for (const file of files) {
      const path = resolveFileDiffPath(file);
      for (const thread of detail.reviewThreads) {
        if (
          thread.path === path &&
          thread.line !== null &&
          isLineInFileDiff(file, thread.side, thread.line)
        ) {
          placed.add(thread.id);
        }
      }
    }
    return placed;
  })();
  const placedPendingIds = (() => {
    const placed = new Set<string>();
    if (commit !== null) return placed;
    for (const file of files) {
      const path = resolveFileDiffPath(file);
      for (const comment of pendingComments) {
        const anchor = getReviewPositionAnchor(comment.position);
        if (comment.path === path && isLineInFileDiff(file, anchor.side, anchor.line)) {
          placed.add(comment.id);
        }
      }
    }
    return placed;
  })();
  // Hashing what the annotations show is the costly part of an item's version, and none of it
  // moves when a file is ticked or folded, so it is kept apart from the two that do.
  const annotatedFiles = files.map((fileDiff) => {
    const fileKey = buildFileDiffRenderKey(fileDiff);
    const path = resolveFileDiffPath(fileDiff);
    const groups = new Map<string, MutableAnnotationGroup>();
    const groupAt = (side: PullRequestDiffSide, line: number) => {
      const key = `${side}:${line}`;
      const existing = groups.get(key);
      if (existing) return existing;
      const created: MutableAnnotationGroup = {
        side,
        line,
        threads: [],
        pending: [],
        draft: false,
      };
      groups.set(key, created);
      return created;
    };
    for (const thread of detail.reviewThreads) {
      if (thread.path !== path || thread.line === null) continue;
      if (!placedThreadIds.has(thread.id)) continue;
      groupAt(thread.side, thread.line).threads.push(thread);
    }
    if (commit === null) {
      for (const comment of pendingComments) {
        if (comment.path !== path || !placedPendingIds.has(comment.id)) continue;
        const anchor = getReviewPositionAnchor(comment.position);
        groupAt(anchor.side, anchor.line).pending.push(comment);
      }
    }
    if (draft?.fileKey === fileKey) {
      const anchor = getReviewPositionAnchor(draft.position);
      groupAt(anchor.side, anchor.line).draft = true;
    }
    const annotations: ReviewAnnotation[] = [...groups.values()].map((group) => ({
      side: toViewerSide(group.side),
      lineNumber: group.line,
      metadata: { threads: group.threads, pending: group.pending, draft: group.draft },
    }));
    return {
      fileKey,
      path,
      fileDiff,
      annotations,
      // The viewer re-renders an item only when its version changes, so everything the
      // annotations show has to be part of it.
      annotationsVersion: fnv1a32(
        annotations
          .map(
            ({ side, lineNumber, metadata }) =>
              `${side}:${lineNumber}:${metadata.draft ? "d" : ""}:${metadata.pending
                .map((comment) => `${comment.id}:${comment.body}`)
                .join(",")}:${metadata.threads
                .map(
                  (thread) =>
                    `${thread.id}:${thread.isResolved ? "r" : ""}:${thread.isOutdated ? "o" : ""}:${thread.comments
                      .map(
                        (comment) =>
                          `${comment.id}:${comment.author?.login ?? ""}:${comment.createdAt}:${comment.body}:${(
                            comment.reactions ?? []
                          )
                            .map((r) => `${r.content}:${r.count}:${r.viewerHasReacted ? "v" : ""}`)
                            .join(",")}`,
                      )
                      .join(";")}`,
                )
                .join(",")}`,
          )
          .join("|"),
      ),
    };
  });
  const items = annotatedFiles.map(
    ({ fileKey, path, fileDiff, annotations, annotationsVersion }) => {
      const viewed = filesViewedEnabled && isFileViewed(path);
      const collapsed = isFileDiffCollapsed(path, effectiveFoldOverride, foldChoices, viewed);
      // Ticking a file that is already folded changes no fold, so without this the box on
      // screen would keep saying the opposite of what the count says.
      const viewedMark = filesViewedEnabled
        ? `e${filesViewedWritable ? "w" : ""}${viewed ? "v" : ""}${isFileViewedStale(path) ? "s" : ""}`
        : "";
      return {
        id: fileKey,
        type: "diff" as const,
        fileDiff,
        annotations,
        collapsed,
        version: fnv1a32(`${collapsed ? "1" : "0"}:${viewedMark}:${annotationsVersion}`),
      };
    },
  );
  const omittedFileStats = new Map(
    loadedSlices.flatMap((slice) =>
      slice.omittedFileStats.map((file) => [file.path, file] as const),
    ),
  );
  const sourceFileStats = new Map(
    parsedSlices.flatMap((parsed) =>
      parsed?.kind === "files"
        ? parsed.files.map(
            (file, index) =>
              [
                buildFileDiffRenderKey(file),
                getDiffLineStat([parsed.sourceFiles[index] ?? file]),
              ] as const,
          )
        : [],
    ),
  );
  const fileKeys = items.map((item) => item.id);
  const collapsedFileKeys = new Set(
    items.filter((item) => item.collapsed === true).map((item) => item.id),
  );
  const allFilesCollapsed = areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys);
  const fileTreeEntries = diffFileTreeEntries(files);
  // A failed slice must not be asked for again on its own. The files already loaded keep the
  // sentinel on screen, so re-arming it after a failure would request the same slice forever.
  // Nor while the loaded pages are being read again: asking for the next one would move the
  // cursor off the walk and leave the pages after it unchecked.
  const canLoadNextSlice =
    nextCursor !== null &&
    nextCursor !== cursor &&
    !revalidating &&
    !diffQuery.isPending &&
    diffQuery.error === null;
  const loadNextSlice = () => {
    if (nextCursor === null) return;
    setSliceState((previous) => ({ ...previous, cursor: nextCursor }));
  };
  const sentinelRef = (node: HTMLDivElement | null) => {
    if (node === null || !canLoadNextSlice) return;
    return observeIntersection(
      node,
      (entry) => {
        if (entry.isIntersecting) loadNextSlice();
      },
      { rootMargin: "240px" },
    );
  };
  // A stable identity: the viewer's SlotPortals memoizes each file's header/annotation portal on
  // these render props, so a fresh function here would recreate every visible file's portal on
  // every tab re-render (a line-selection drag, a keystroke in the draft, a review-store update).
  const setFileFolded = (path: string, folded: boolean) =>
    setFoldChoices((current) => {
      if (current.get(path) === folded) return current;
      return new Map(current).set(path, folded);
    });
  const codeViewReveal = useCodeViewFileReveal();
  const revealFile = (path: string) => {
    const item = items.find((candidate) => resolveFileDiffPath(candidate.fileDiff) === path);
    if (item === undefined) return;
    if (item.collapsed === true) setFileFolded(path, false);
    codeViewReveal.request(item.id);
  };
  // The tick and the fold are one gesture: clearing a file puts it away, un-clearing brings it
  // back. Folding is still held apart from what has been ticked, so folding everything ticks
  // nothing off.
  const setFileViewed = (path: string, viewed: boolean, event: Event) => {
    const range = getFileViewedRange(
      annotatedFiles.map((file) => ({ ...file, fileKey: file.path })),
      path,
      "shiftKey" in event && event.shiftKey === true ? lastViewedPath : null,
    );
    setLastViewedPath(path);
    for (const file of range) {
      if (!setViewed(file.path, viewed)) continue;
      setFoldChoices((current) =>
        foldChoicesAfterViewed(file.path, viewed, effectiveFoldOverride, current),
      );
    }
    const headerPinned = isPinnedHeaderEvent(event, codeViewFrameRef.current);
    // Ticked from the pinned header, the reader is part way through the file. Left to itself
    // the viewer holds the next file where it was on screen and fills the gap from above with
    // code already read; putting the folded header at the top brings the next file up instead.
    if (!viewed || !headerPinned) return;
    const item = items.find((candidate) => resolveFileDiffPath(candidate.fileDiff) === path);
    if (item !== undefined) codeViewReveal.request(item.id);
  };
  const answeredReveal = useRef<number | null>(null);
  const answerReveal = useEffectEvent(() => {
    if (revealRequest === null || answeredReveal.current === revealRequest.nonce) return;
    if (!items.some((item) => resolveFileDiffPath(item.fileDiff) === revealRequest.path)) {
      if (canLoadNextSlice) loadNextSlice();
      return;
    }
    answeredReveal.current = revealRequest.nonce;
    revealFile(revealRequest.path);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals a requested file after its diff page loads
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A reveal for a file not loaded yet pages forward, which sets the slice cursor.
    answerReveal();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-checked as pages load until the requested file arrives.
  }, [canLoadNextSlice, items, revealRequest]);
  const toggleAllFiles = () => {
    setFoldOverride(areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys) ? "expanded" : "folded");
    setFoldChoices(new Map());
  };
  const orderedCommits =
    // By instant, not by the text: GitLab keeps a commit's own UTC offset, so two commits
    // from different zones would sort by how they were written rather than when they landed.
    detail.commits.toSorted(
      (left, right) => Date.parse(right.committedDate) - Date.parse(left.committedDate),
    );
  const beginComment = (
    range: SelectedLineRange | null,
    context: {
      item: CodeViewItem<ReviewAnnotationGroup>;
    },
  ) => {
    if (!range || !canSelectLines) return;
    const item = context.item;
    if (item.type !== "diff") return;
    const file = files.find((candidate) => buildFileDiffRenderKey(candidate) === item.id);
    if (!file) return;
    // On a host without ranged comments a range collapses to its last line: one that silently
    // lost its first line there would be worse than one line.
    const path = resolveFileDiffPath(file);
    const previousPath = resolveFileDiffPreviousPath(file);
    const sourceFile = parsedSlices
      .flatMap((slice) => (slice?.kind === "files" ? slice.sourceFiles : []))
      .find((candidate) => resolveFileDiffPath(candidate) === path);
    const anchor =
      (sourceFile && resolveDiffReviewAnchor(sourceFile, range, rangeComments)) ??
      resolveDiffReviewAnchor(file, range, rangeComments);
    if (anchor === null) return;
    setDraft({
      fileKey: item.id,
      path,
      oldPath: previousPath === path ? null : previousPath,
      ...anchor,
      range,
    });
  };
  const finishSelection = (
    anchor: DraftAnchor,
    text: string,
    onFinish: (comment: ReviewCommentContext) => void,
  ) => {
    const file = files.find((candidate) => buildFileDiffRenderKey(candidate) === anchor.fileKey);
    const comment =
      file === undefined
        ? null
        : buildDiffReviewComment({
            id: `pull-request-selection:${anchor.fileKey}:${anchor.range.start}:${anchor.range.end}`,
            sectionId: `pull-request:${detail.number}`,
            sectionTitle: `PR #${detail.number} review`,
            filePath: anchor.path,
            fileDiff: file,
            range: anchor.range,
            text,
          });
    setDraft(null);
    setSelectedLines(null);
    if (comment !== null) onFinish(comment);
  };
  // Keep these render props stable: SlotPortals recreates every visible portal when an identity
  // changes, which makes ordinary tab updates janky.
  const renderCodeViewFooter = () =>
    // Show a footer only while pages remain or a failed revalidation leaves unchecked pages.
    nextCursor === null && !(revalidating && diffQuery.error !== null) ? null : (
      <div
        ref={sentinelRef}
        className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
      >
        {diffQuery.error !== null ? (
          <>
            <span>
              {revalidating
                ? "This diff could not be checked for new changes."
                : "The rest of this diff could not be loaded."}
            </span>
            <Button size="xs" variant="outline" onClick={() => diffQuery.refresh()}>
              Retry
            </Button>
          </>
        ) : diffQuery.isPending ? (
          "Loading more files..."
        ) : null}
      </div>
    );
  const renderHeaderPrefix = (item: CodeViewItem<ReviewAnnotationGroup>) => {
    if (item.type !== "diff") return null;
    const path = resolveFileDiffPath(item.fileDiff);
    // The item the viewer is drawing already carries the state the memo settled on, so the
    // chevron follows it rather than recomputing the default here.
    const collapsed = item.collapsed === true;
    return (
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand diff" : "Collapse diff"}
        className="mr-1"
        onClick={(event) => {
          event.stopPropagation();
          setFileFolded(path, !collapsed);
        }}
      >
        <MorphIcon className="size-4" icon={collapsed ? ChevronRight : ChevronDown} />
      </Button>
    );
  };
  const codeViewFrameRef = useRef<HTMLDivElement>(null);
  const fileViewedToggle = {
    enabled: filesViewed.enabled,
    writable: filesViewed.writable,
    isViewed: filesViewed.isViewed,
    isStale: filesViewed.isStale,
    setFileViewed: (path: string, viewed: boolean, event: Event) =>
      setFileViewed(path, viewed, event),
  };
  const renderHeaderMetadata = (item: CodeViewItem<ReviewAnnotationGroup>) => {
    if (item.type !== "diff") return null;
    let { additions, deletions } = sourceFileStats.get(item.id) ?? getDiffLineStat([item.fileDiff]);
    const path = resolveFileDiffPath(item.fileDiff);
    if (additions === 0 && deletions === 0) {
      const withheld = omittedFileStats.get(path);
      if (withheld) ({ additions, deletions } = withheld);
    }
    return (
      <FileViewedToggle
        path={path}
        stat={
          <PullRequestDiffStat
            additions={additions}
            deletions={deletions}
            className="font-mono text-2xs"
          />
        }
      />
    );
  };

  const diffViewOptions = {
    diffStyle: diffLayout === "split" ? ("split" as const) : ("unified" as const),
    lineDiffType: "none" as const,
    overflow: wordWrap ? ("wrap" as const) : ("scroll" as const),
    theme: resolveDiffThemeName(resolvedTheme),
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    themeType: resolvedTheme,
    stickyHeaders: true,
    loadDiffFiles,
    enableGutterUtility: canSelectLines && draft === null,
    enableLineSelection: canSelectLines && draft === null,
    onGutterUtilityClick: beginComment,
    onLineSelectionEnd: beginComment,
    onPostRender: codeViewReveal.flush,
  };
  const runThreadCommand = async (
    label: string,
    run: () => Promise<{
      readonly _tag: string;
    }>,
  ): Promise<boolean> => {
    if (threadPending) return false;
    setThreadPending(true);
    const result = await run();
    setThreadPending(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: label });
      return false;
    }
    onRefresh();
    return true;
  };
  const renderThreadCard = (thread: PullRequestReviewThread) => (
    <ReviewThreadCard
      // Named with the pull request too: a thread's id is the host's own, and two pull requests
      // can hand out the same one — which would leave one card's open editor standing over the
      // other's conversation.
      key={`${reference.projectId}#${reference.number}:${thread.id}`}
      thread={thread}
      workspaceRoot={detail.workspaceRoot}
      canReply={review.reply}
      canResolve={review.resolve && canResolvePullRequestThread(detail, thread)}
      canReact={pullRequestCanReact(detail.capabilities, "review-comment")}
      environmentId={environmentId}
      reference={reference}
      pending={threadPending}
      fixPending={pendingFinding === pullRequestFindingKey({ kind: "thread", thread })}
      fixLabel={fixFindingLabel}
      {...(onFixFinding ? { onFix: () => onFixFinding({ kind: "thread", thread }) } : {})}
      onLoadMore={async (cursor): Promise<PullRequestThreadCommentsResult | null> => {
        const result = await loadThreadComments({
          environmentId,
          input: { ...reference, threadId: thread.id, cursor },
        });
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "More comments could not be loaded",
          });
          return null;
        }
        return result.value;
      }}
      onReply={(body) =>
        runThreadCommand("Reply could not be posted", () =>
          replyToThread({
            environmentId,
            input: { ...reference, threadId: thread.id, body },
          }),
        )
      }
      canEditComment={(comment) =>
        canEditPullRequestComment(detail, {
          author: comment.author,
          kind: "review-comment",
          canEdit: comment.canEdit,
        })
      }
      onEditComment={(commentId, body) =>
        runThreadCommand("The comment could not be saved", () =>
          updateComment({
            environmentId,
            input: { ...reference, commentId, kind: "review-comment", body },
          }),
        )
      }
      onToggleResolved={() =>
        void runThreadCommand("The conversation could not be updated", () =>
          setThreadResolution({
            environmentId,
            input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
          }),
        )
      }
      onReacted={onRefresh}
    />
  );
  const renderPendingCard = (comment: PendingReviewComment) => (
    <PendingReviewCommentCard
      key={comment.id}
      comment={comment}
      workspaceRoot={detail.workspaceRoot}
      environmentId={environmentId}
      onEdit={(body) => updatePendingComment(reviewKey, comment.id, body)}
      onRemove={() => removeComment(reviewKey, comment.id)}
    />
  );
  const renderAnnotation = (...[annotation]: CodeViewAnnotationArgs<ReviewAnnotationGroup>) => (
    <div className="py-1 font-sans text-foreground">
      {annotation.metadata.threads.map(renderThreadCard)}
      {annotation.metadata.pending.map(renderPendingCard)}
      {annotation.metadata.draft && draft ? (
        <DiffCommentAnnotation
          kind="draft"
          rangeLabel={`${draft.path}:${getReviewPositionAnchor(draft.position).line}`}
          text=""
          submitLabel={canCommentOnLines ? "Add to review" : "Add to agent"}
          {...(canCommentOnLines && onAddToAgentSelection
            ? {
                secondaryAction: {
                  label: "Add to agent",
                  onAction: (text: string) =>
                    finishSelection(draft, text, (comment) =>
                      onAddToAgentSelection({ comment, request: text }),
                    ),
                },
              }
            : {})}
          onCancel={() => {
            setDraft(null);
            setSelectedLines(null);
          }}
          onComment={(body) => {
            if (!canCommentOnLines) {
              if (onAddToAgentSelection) {
                finishSelection(draft, body, (comment) =>
                  onAddToAgentSelection({ comment, request: body }),
                );
              }
              return;
            }
            addComment(reviewKey, {
              id: nextPendingReviewCommentId(),
              path: draft.path,
              ...(draft.oldPath === null ? {} : { oldPath: draft.oldPath }),
              ...(draft.startPosition === undefined ? {} : { startPosition: draft.startPosition }),
              position: draft.position,
              body,
            });
            setDraft(null);
            setSelectedLines(null);
          }}
        />
      ) : null}
    </div>
  );
  const selectedCommit = orderedCommits.find((entry) => entry.oid === commit);
  const scopeLabel = selectedCommit ? selectedCommit.messageHeadline : "All commits";
  const changeIgnoreWhitespace = (next: boolean) => {
    setIgnoreWhitespace(next);
    setDraft(null);
    setSelectedLines(null);
  };
  const toolbar = (
    <div className="@container flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {orderedCommits.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="xs" variant="secondary" />}
              className="min-w-0 max-w-64"
              aria-label={`Diff scope: ${scopeLabel}`}
            >
              <span className="truncate">{scopeLabel}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-[min(28rem,calc(100vw-2rem))]">
              <DropdownMenuRadioGroup
                value={commit ?? "all"}
                onValueChange={(value) => onSelectedCommitChange(value === "all" ? null : value)}
              >
                <DropdownMenuRadioItem value="all" closeOnClick>
                  <span>All commits</span>
                </DropdownMenuRadioItem>
                {orderedCommits.slice(0, visibleCommitCount).map((entry) => (
                  <DropdownMenuRadioItem key={entry.oid} value={entry.oid} closeOnClick>
                    <span className="flex items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger
                          render={<span className="min-w-0 truncate">{entry.messageHeadline}</span>}
                        />
                        <TooltipPopup side="top">{entry.messageHeadline}</TooltipPopup>
                      </Tooltip>
                      <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                        {entry.oid.slice(0, 7)}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {orderedCommits.length > visibleCommitCount ? (
                <DropdownMenuItem
                  closeOnClick={false}
                  onClick={() => setVisibleCommitCount((count) => count + COMMIT_PAGE_SIZE)}
                >
                  <span className="text-muted-foreground">
                    Show more ({orderedCommits.length - visibleCommitCount} left)
                  </span>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <PullRequestMetaLine>
          <span className="shrink-0 tabular-nums">
            {files.length} {files.length === 1 ? "file" : "files"}
            {nextCursor === null ? "" : "+"}
          </span>
          {filesViewed.enabled && files.length > 0 ? (
            <span className="flex min-w-0 items-center gap-1 tabular-nums">
              <span className="shrink-0">
                {filesViewed.viewedCount} / {files.length}
              </span>
              <span className="truncate">
                {viewedFilesStore === "environment" ? `viewed in ${APP_BASE_NAME}` : "viewed"}
              </span>
              {viewedFilesStore === "environment" ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                    <InfoIcon
                      aria-label="These ticks are kept here, not on the host"
                      className="text-muted-foreground size-3.5"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    This host keeps no shared record of which files you have read, so these ticks
                    are kept by this environment. They follow you between the apps connected to it,
                    but the host's own web UI will not show them.
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {filesViewed.error !== null ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                    <TriangleAlertIcon
                      aria-label="Your ticks could not be read"
                      className="size-3.5 text-warning-foreground"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    The boxes below are whatever was last read, and empty if nothing has been read
                    yet. {filesViewed.error}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {filesViewed.truncated ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                    <TriangleAlertIcon
                      aria-label="This count covers only part of the change"
                      className="size-3.5 text-warning-foreground"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    This change has more files than the host will report ticks for in one read, so
                    the count is short and some boxes below start empty.
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          ) : null}
          {withheldContent ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                <TriangleAlertIcon
                  aria-label="Some of this diff was not shown"
                  className="size-3.5 text-warning-foreground"
                />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                The host withheld part of this diff: a binary file, or a change too large to inline.
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {commit !== null && review.inlineComment ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                <MessageSquareOffIcon
                  aria-label="Line comments are written from the whole change"
                  className="size-3.5"
                />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                A comment is anchored to the whole change, so switch to All commits to write one.
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </PullRequestMetaLine>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={<Button size="icon-sm" variant="ghost" />}
                  className="@lg:hidden"
                  aria-label="Diff options"
                />
              }
            >
              <Settings2Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Diff options</TooltipPopup>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuCheckboxItem
              checked={ignoreWhitespace}
              onCheckedChange={(checked) => changeIgnoreWhitespace(checked)}
            >
              Hide whitespace changes
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={wordWrap}
              onCheckedChange={(checked) => setWordWrap(checked)}
            >
              Wrap lines
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={diffLayout}
              onValueChange={(value) => {
                if (value === "stacked" || value === "split") {
                  updateClientSettings({ diffLayout: value });
                }
              }}
            >
              <DropdownMenuRadioItem value="stacked" closeOnClick>
                Stacked
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split" closeOnClick>
                Split
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="hidden items-center gap-1 @lg:flex">
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={
                    ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                  }
                  variant="ghost"
                  size="sm"
                  pressed={ignoreWhitespace}
                  onPressedChange={(pressed) => changeIgnoreWhitespace(Boolean(pressed))}
                />
              }
            >
              <PilcrowIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
            </TooltipPopup>
          </Tooltip>
          <ToggleGroup
            aria-label="Diff layout"
            className="shrink-0"
            variant="segmented"
            value={[diffLayout]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "stacked" || next === "split") {
                updateClientSettings({ diffLayout: next });
              }
            }}
          >
            <Toggle aria-label="Stacked diff view" value="stacked">
              <Rows3Icon className="size-3.5" />
            </Toggle>
            <Toggle aria-label="Split diff view" value="split">
              <Columns2Icon className="size-3.5" />
            </Toggle>
          </ToggleGroup>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                  variant="ghost"
                  size="sm"
                  pressed={wordWrap}
                  onPressedChange={(pressed) => {
                    setWordWrap(Boolean(pressed));
                  }}
                />
              }
            >
              <TextWrapIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            </TooltipPopup>
          </Tooltip>
        </div>
        {fileKeys.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={allFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={toggleAllFiles}
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allFilesCollapsed ? ChevronsUpDown : ChevronsDownUp}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {fileKeys.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                  variant="ghost"
                  size="sm"
                  pressed={fileTreeOpen}
                  onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
                />
              }
            >
              <FolderTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {fileTreeOpen ? "Hide file tree" : "Show file tree"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
  const withToolbar = (body: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      {revalidating && diffQuery.error !== null ? (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-border/60 py-2 text-xs text-muted-foreground">
          <span>This diff could not be checked for new changes.</span>
          <Button size="xs" variant="outline" onClick={() => diffQuery.refresh()}>
            Retry
          </Button>
        </div>
      ) : null}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
    </div>
  );
  if (diffQuery.isPending && loadedSlices.length === 0) {
    return withToolbar(<DiffPanelLoadingState label="Loading pull request diff..." />);
  }
  if (diffQuery.error && loadedSlices.length === 0) {
    return withToolbar(
      <PullRequestDiffUnavailableState
        error={diffQuery.error}
        provider={detail.provider}
        url={detail.url}
        onRetry={() => diffQuery.refresh()}
      />,
    );
  }
  // Only once the diff is whole: returning here while a cursor is outstanding would take the
  // sentinel off screen and end the walk, leaving the rest of the change unasked for.
  const rawSlices =
    nextCursor === null
      ? parsedSlices.flatMap((parsed) => (parsed?.kind === "raw" ? [parsed] : []))
      : [];
  if (files.length === 0 && rawSlices.length > 0) {
    return withToolbar(
      <div className="space-y-4 px-4 py-5">
        {rawSlices.map((slice) => (
          <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
          </div>
        ))}
      </div>,
    );
  }
  if (items.length === 0 && nextCursor === null) {
    return withToolbar(
      <p className="px-4 py-5 text-sm text-muted-foreground">
        {commit === null
          ? "This pull request has no file changes."
          : "This commit has no file changes."}
      </p>,
    );
  }
  const orphanThreads = detail.reviewThreads.filter((thread) => !placedThreadIds.has(thread.id));
  const orphanPending = pendingComments.filter((comment) => !placedPendingIds.has(comment.id));
  // A file carrying five stranded conversations should read as that file once rather than as
  // five copies of its path.
  const orphanFiles = new Map<
    string,
    {
      threads: PullRequestReviewThread[];
      pending: PendingReviewComment[];
    }
  >();
  for (const thread of orphanThreads) {
    const existing = orphanFiles.get(thread.path);
    if (existing) existing.threads.push(thread);
    else orphanFiles.set(thread.path, { threads: [thread], pending: [] });
  }
  for (const comment of orphanPending) {
    const existing = orphanFiles.get(comment.path);
    if (existing) existing.pending.push(comment);
    else orphanFiles.set(comment.path, { threads: [], pending: [comment] });
  }
  const unstructured =
    rawSlices.length === 0 ? null : (
      <div className="space-y-4 border-t border-border/60 px-4 py-5">
        {rawSlices.map((slice) => (
          <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
          </div>
        ))}
      </div>
    );
  return (
    <div data-diff-search-root tabIndex={-1} className="flex h-full min-h-0 flex-col outline-none">
      {toolbar}
      {orphanFiles.size > 0 ? (
        <div className="shrink-0 border-b border-border/60">
          <Collapsible open={orphansOpen} onOpenChange={setOrphansOpen}>
            <h2>
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground">
                <span>
                  {nextCursor === null
                    ? "Comments not on the current diff"
                    : "Comments not on the diff loaded so far"}
                </span>
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3.5 transition-transform", orphansOpen && "rotate-90")}
                />
                <span aria-hidden className="tabular-nums">
                  {orphanThreads.length + orphanPending.length}
                </span>
                <span className="sr-only">
                  {orphanThreads.length === 1
                    ? "1 conversation"
                    : `${orphanThreads.length} conversations`}
                  {orphanPending.length > 0
                    ? ` and ${orphanPending.length} pending comments`
                    : null}
                </span>
              </CollapsibleTrigger>
            </h2>
            <CollapsiblePanel>
              <div className="max-h-64 space-y-3 overflow-auto px-4 pb-3">
                {[...orphanFiles].map(([path, { threads, pending }]) => (
                  <div key={path}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <p className="truncate px-3 text-xs text-muted-foreground">{path}</p>
                        }
                      />
                      <TooltipPopup side="top">{path}</TooltipPopup>
                    </Tooltip>
                    <div className="mt-1 space-y-2">
                      {threads.map((thread) => (
                        <div key={thread.id}>
                          {thread.line === null ? null : (
                            <p className="px-3 text-xs text-muted-foreground">Line {thread.line}</p>
                          )}
                          {renderThreadCard(thread)}
                        </div>
                      ))}
                      {pending.map((comment) => (
                        <div key={comment.id}>
                          <p className="px-3 text-xs text-muted-foreground">
                            Line {getReviewPositionAnchor(comment.position).line}
                          </p>
                          {renderPendingCard(comment)}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={codeViewFrameRef}
          className="relative min-h-0 min-w-0 flex-1"
          // The header lives in the viewer's shadow tree, so the capture listener walks
          // `composedPath` — the only way to see through the shadow boundary.
          onClickCapture={(event) => {
            const composedPath = event.nativeEvent.composedPath?.() ?? [];
            for (const node of composedPath) {
              if (!(node instanceof HTMLElement)) continue;
              // A control inside the header — the collapse chevron — handles itself, and
              // this capture listener fires before its own click does. Leave it alone or
              // the two toggles cancel out.
              if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                return;
              }
              if (node.hasAttribute("data-viewed-toggle")) return;
              if (node.hasAttribute("data-diffs-header")) {
                const filePath = node.querySelector("[data-title]")?.textContent?.trim();
                if (filePath === undefined || filePath === "") return;
                const item = items.find(
                  (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
                );
                if (item !== undefined) setFileFolded(filePath, item.collapsed !== true);
                return;
              }
            }
          }}
        >
          {/* The viewer virtualizes against the element it is told is scrolling and places its
            rows absolutely, so it has to own that element — the thread diff panel hands it the
            same one. Scrolling from a parent instead leaves it painting over its neighbours. */}
          <FileViewedToggleContext value={fileViewedToggle}>
            <StyledDiffCodeView<ReviewAnnotationGroup>
              className="@container h-full overflow-auto [scrollbar-gutter:stable]"
              containerRef={scrollerRef}
              viewerRef={codeViewReveal.attach}
              items={items}
              selectedLines={selectedLines}
              onSelectedLinesChange={setSelectedLines}
              options={diffViewOptions}
              renderCodeViewFooter={renderCodeViewFooter}
              renderHeaderPrefix={renderHeaderPrefix}
              renderHeaderMetadata={renderHeaderMetadata}
              renderAnnotation={renderAnnotation}
              // Find can ask again before the unfolded file arrives, so this unfolds and never folds.
              onRevealSearchMatch={(item) => {
                if (item.type === "diff") {
                  setFileFolded(resolveFileDiffPath(item.fileDiff), false);
                }
              }}
              unsafeCSSExtra={REPLACE_FILE_COUNTS_CSS}
            />
          </FileViewedToggleContext>
        </div>
        {fileTreeOpen ? (
          <aside className="flex w-[min(20rem,40%)] min-w-48 shrink-0 border-l border-border/60">
            <DiffFileTree
              ariaLabel={`Pull request #${detail.number} files`}
              entries={fileTreeEntries}
              onSelectFile={revealFile}
              footer={
                nextCursor === null ? null : (
                  <div className="shrink-0 border-t border-border/60 p-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      className="w-full"
                      disabled={diffQuery.isPending || (revalidating && diffQuery.error === null)}
                      onClick={diffQuery.error !== null ? () => diffQuery.refresh() : loadNextSlice}
                    >
                      {diffQuery.error !== null
                        ? "Retry"
                        : diffQuery.isPending
                          ? "Loading more files..."
                          : "Load more files"}
                    </Button>
                  </div>
                )
              }
            />
          </aside>
        ) : null}
      </div>
      {unstructured}
    </div>
  );
}
export default PullRequestCodeTab;
