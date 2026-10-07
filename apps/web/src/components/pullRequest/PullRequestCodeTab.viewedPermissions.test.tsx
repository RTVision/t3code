import { RegistryContext } from "@effect/atom-react";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
  type PullRequestDetailView,
  type PullRequestFilesViewedResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { act, createElement, useState, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
vi.mock("@t3tools/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const diffQuery = Atom.make(0);
const viewedQuery = Atom.make(0);
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
);
const state = vi.hoisted(() => ({
  writes: vi.fn(),
  reveal: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  viewed: { files: [], truncated: false } as PullRequestFilesViewedResult,
  diff: {
    patch:
      "diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    truncated: false,
    nextCursor: null,
  },
}));
const setFilesViewed = createEnvironmentRpcCommand(runtime, {
  label: "test.set-files-viewed",
  tag: WS_METHODS.pullRequestsSetFilesViewed,
  concurrency: { mode: "serial", key: () => "pr" },
  execute: (input) =>
    Effect.promise(async () => {
      await state.writes(input);
      return {
        files: input.files.map(({ path, viewed }) => ({
          path,
          state: viewed ? ("viewed" as const) : ("unviewed" as const),
        })),
        truncated: false,
      };
    }),
});
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    diff: () => diffQuery,
    filesViewed: () => viewedQuery,
    get setFilesViewed() {
      return setFilesViewed;
    },
    get replyToThread() {
      return setFilesViewed;
    },
    get setThreadResolution() {
      return setFilesViewed;
    },
    get updateComment() {
      return setFilesViewed;
    },
    get threadComments() {
      return setFilesViewed;
    },
    get diffFileContents() {
      return setFilesViewed;
    },
  },
}));
// Read responses are fixed at the transport boundary; command dispatch and permission atoms are real.
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: unknown) => ({
    data: query === diffQuery ? state.diff : state.viewed,
    error: null,
    isPending: false,
    refresh: state.refresh,
  }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => ({
    diffFilesCollapsed: false,
    diffLayout: "stacked",
    wordWrap: false,
    diffIgnoreWhitespace: false,
  }),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useLocalStorage", () => ({ useLocalStorage: () => useState(false) }));
vi.mock("./pullRequestReviewStore", () => ({
  pullRequestReviewKey: () => "pr",
  usePendingReviewComments: () => [],
  usePullRequestReviewStore: () => vi.fn(),
}));
vi.mock("../diffs/useCodeViewFileReveal", () => ({ useCodeViewFileReveal: () => state.reveal }));
vi.mock("../diffs/useDiffSearch", () => ({ useDiffSearch: () => ({ onPostRender: vi.fn() }) }));
vi.mock("../diffs/DiffSearchBar", () => ({
  DiffSearchToggle: () => null,
  DiffSearchBar: () => null,
}));
vi.mock("../diffs/DiffCommentAnnotation", () => ({ DiffCommentAnnotation: () => null }));
vi.mock("../diffs/DiffFileTree", () => ({ DiffFileTree: () => null }));
vi.mock("./PullRequestReviewAnnotation", () => ({
  PendingReviewCommentCard: () => null,
  ReviewThreadCard: () => null,
}));
vi.mock("../DiffPanelShell", () => ({ DiffPanelLoadingState: () => null }));
vi.mock("~/lib/syntaxHighlighting", () => ({ PREFERRED_HIGHLIGHTER: "shiki" }));
vi.mock("../diffs/StyledDiffCodeView", () => ({
  StyledDiffCodeView: (props: {
    items: { collapsed: boolean; version: string }[];
    renderHeaderMetadata: (item: unknown) => ReactNode;
  }) =>
    createElement(
      "section",
      { "data-folded": props.items[0]?.collapsed, "data-version": props.items[0]?.version },
      props.renderHeaderMetadata(props.items[0]),
    ),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../ui/checkbox", () => ({ Checkbox: (props: object) => createElement("input", props) }));
vi.mock("../ui/button", () => ({ Button: (props: object) => createElement("button", props) }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: () => null,
  TooltipPopup: () => null,
}));
vi.mock("../ui/toggle-group", () => ({ Toggle: () => null, ToggleGroup: () => null }));
vi.mock("../ui/menu", () => ({
  DropdownMenu: () => null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuRadioGroup: () => null,
  DropdownMenuRadioItem: () => null,
  DropdownMenuTrigger: () => null,
}));
vi.mock("../ui/collapsible", () => ({
  Collapsible: () => null,
  CollapsiblePanel: () => null,
  CollapsibleTrigger: () => null,
}));
vi.mock("./pullRequestPresentation", () => ({
  PullRequestDiffStat: () => null,
  PullRequestMetaLine: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/components/MorphIcon", () => ({ MorphIcon: () => null }));
import PullRequestCodeTab from "./PullRequestCodeTab";
const environmentId = EnvironmentId.make("viewed-permission");
const reference: PullRequestRef = {
  projectId: ProjectId.make("project"),
  repository: "acme/web",
  number: 42,
};
const detail = {
  number: 42,
  updatedAt: "now",
  commits: [],
  reviewThreads: [],
  capabilities: {
    viewedFiles: "host",
    review: { inlineComment: false, reply: false, resolve: false },
  },
  viewerPermissions: { comment: false, resolve: false },
} as unknown as PullRequestDetailView;
class HeaderNode {
  hasAttribute(name: string) {
    return name === "data-diffs-header";
  }
  getBoundingClientRect() {
    return { top: 0 };
  }
}
let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer;
const grant = (allowed: boolean) =>
  registry.set(
    sessions(environmentId),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: allowed ? [AuthSourceControlWriteScope] : [],
      permissions: allowed ? [AuthSourceControlWriteScope] : [],
    }),
  );
const checkbox = () => renderer.root.findByType("input");
const folded = () => renderer.root.findByType("section").props["data-folded"] === true;
const change = (callback = checkbox().props.onCheckedChange, viewed = true) =>
  callback(viewed, { event: { composedPath: () => [new HeaderNode()] } });
async function mount(allowed: boolean, viewed = false) {
  registry = AtomRegistry.make();
  registry.mount(sessions(environmentId));
  grant(allowed);
  state.viewed = {
    files: [{ path: "a.ts", state: viewed ? "viewed" : "unviewed" }],
    truncated: false,
  };
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <PullRequestCodeTab
          environmentId={environmentId}
          reference={reference}
          detail={detail}
          selectedCommitOid={null}
          onSelectedCommitChange={() => {}}
          onRefresh={() => {}}
        />
      </RegistryContext.Provider>,
      { createNodeMock: () => new HeaderNode() },
    );
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("HTMLElement", HeaderNode);
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  registry?.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps read-only viewed marks readable and rejects callbacks before changing marks or folds", async () => {
  await mount(false, true);
  expect(checkbox().props.checked).toBe(true);
  expect(folded()).toBe(true);
  await act(async () => change(undefined, false));
  expect(checkbox().props.checked).toBe(true);
  expect(folded()).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(checkbox().props.checked).toBe(true);
  expect(folded()).toBe(true);
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.reveal).not.toHaveBeenCalled();
  expect(checkbox().props.disabled).toBe(true);
});
it("checks the live grant before a retained click and resumes after regrant", async () => {
  await mount(true);
  const retained = checkbox().props.onCheckedChange;
  const version = renderer.root.findByType("section").props["data-version"];
  await act(async () => {
    grant(false);
    change(retained);
  });
  expect(checkbox().props.checked).toBe(false);
  expect(folded()).toBe(false);
  expect(checkbox().props.disabled).toBe(true);
  expect(renderer.root.findByType("section").props["data-version"]).not.toBe(version);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.reveal).not.toHaveBeenCalled();
  await act(async () => grant(true));
  expect(checkbox().props.disabled).toBe(false);
  await act(async () => change(retained));
  expect(checkbox().props.checked).toBe(true);
  expect(folded()).toBe(true);
  expect(state.reveal).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(state.writes).toHaveBeenCalledExactlyOnceWith({
    ...reference,
    files: [{ path: "a.ts", viewed: true }],
  });
  expect(state.toast).not.toHaveBeenCalled();
});
it("drops an unsent viewed mark if permission is revoked during debounce", async () => {
  await mount(true);
  await act(async () => change());
  expect(checkbox().props.checked).toBe(true);
  await act(async () => grant(false));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(state.writes).not.toHaveBeenCalled();
  expect(checkbox().props.checked).toBe(false);
  expect(state.toast).not.toHaveBeenCalled();
  await act(async () => grant(true));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(state.writes).not.toHaveBeenCalled();
});

it("rechecks source control permission for a write waiting in the serial command lane", async () => {
  await mount(true);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.writes.mockImplementationOnce(async () => {
    started();
    await gate;
  });
  const target = {
    environmentId,
    input: { ...reference, files: [{ path: "a.ts", viewed: true }] },
  };
  const first = setFilesViewed.run(registry, target);
  await entered;
  const second = setFilesViewed.run(registry, target);
  await act(async () => grant(false));
  release();
  expect((await first)._tag).toBe("Success");
  expect((await second)._tag).toBe("Failure");
  expect(state.writes).toHaveBeenCalledTimes(1);
});
