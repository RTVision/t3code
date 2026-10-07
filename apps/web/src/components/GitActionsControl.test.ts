import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type EditorChoice,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { isValidElement, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  choice: { kind: "gui", editor: "vscode" } as EditorChoice,
  remote: { mode: "local-exec" } as
    | { mode: "local-exec" }
    | { mode: "remote-links"; host: { kind: "ssh-alias"; host: string } }
    | { mode: "remote-unavailable" },
  opened: vi.fn(),
  toast: vi.fn(),
  primaryScopes: new Set<string>(),
  shell: { branch: "main" } as { branch: string } | null,
  detail: null as { branch: string } | null,
  draft: null as { branch: string; worktreePath: null; envMode: "local" } | null,
  branch: "main",
  commits: 0,
  metadataRequests: [] as { environmentId: string; branch: string }[],
  afterGitAction: undefined as (() => void) | undefined,
  run: null as ((input: { action: "commit"; featureBranch?: boolean }) => Promise<void>) | null,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
  useEffectEvent: (callback: typeof state.run) => {
    state.run = callback;
    return callback;
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "editor-permission"
      ? state.scopes.has(AuthOrchestrationOperateScope)
      : atom === "vcs-state"
        ? { isRunning: false }
        : { availableEditors: ["vscode"] },
}));
vi.mock("~/state/entities", () => ({
  useThreadProjection: (ref: unknown) =>
    ref === null || state.detail === null ? null : { projection: { thread: state.detail } },
  useThreadShell: () => state.shell,
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope),
  readEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => null } }));
vi.mock("~/state/sourceControl", () => ({ sourceControlEnvironment: {} }));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { status: () => null },
  vcsActionManager: { stateAtom: () => "vcs-state" },
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: {
    updateMetadata: async ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { branch: string };
    }) => {
      state.metadataRequests.push({ environmentId, branch: input.branch });
      if (!state.scopes.has(AuthOrchestrationOperateScope))
        return AsyncResult.failure(Cause.fail(new Error("Task denied")));
      if (state.shell) state.shell.branch = input.branch;
      if (state.detail) state.detail.branch = input.branch;
      return AsyncResult.success(undefined);
    },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      isRepo: true,
      refName: "main",
      isDefaultRef: false,
      hasPrimaryRemote: true,
      hasWorkingTreeChanges: true,
      workingTree: { files: [{ path: "file.ts", status: "modified" }] },
    },
    error: null,
  }),
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (store: {
      getDraftSession: () => typeof state.draft;
      getDraftThreadByRef: () => typeof state.draft;
      setDraftThreadContext: (_target: unknown, input: { branch: string }) => void;
    }) => unknown,
  ) =>
    select({
      getDraftSession: () => state.draft,
      getDraftThreadByRef: () => state.draft,
      setDraftThreadContext: (_target, input) => {
        if (state.draft) state.draft.branch = input.branch;
      },
    }),
}));
vi.mock("~/lib/sourceControlActions", () => ({
  useSourceControlActionRunning: () => false,
  useVcsInitAction: () => ({}),
  useVcsPullAction: () => ({}),
  useSourceControlPublishRepositoryAction: () => ({}),
  useGitStackedAction: () => ({
    run: async ({ featureBranch }: { featureBranch?: boolean }) => {
      state.commits += 1;
      if (featureBranch) state.branch = "feature";
      state.afterGitAction?.();
      return {
        _tag: "Success",
        value: {
          branch: featureBranch
            ? { status: "created", name: "feature" }
            : { status: "skipped_not_requested" },
          toast: { title: "Committed", description: "Committed", cta: { kind: "none" } },
        },
      };
    },
  }),
}));
vi.mock("~/lib/utils", () => ({ cn: () => "", randomUUID: () => "action" }));
vi.mock("~/editorPreferenceStorage", () => ({
  useEditorPreference: (key: string, fallback: unknown) => [
    key === "t3code:editor-choice:v1" ? state.choice : fallback,
    vi.fn(),
  ],
}));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: state.remote, isResolved: true }),
  useRemoteCapableEditors: () => ["vscode"],
  openRemoteEditorUrl: async (url: string) => {
    state.opened(url);
    return true;
  },
}));
vi.mock("~/terminalEditors", () => ({
  useTerminalEditor: () => ({
    capability: { preferenceKey: "", state: "available" },
    connected: true,
    connection: { kind: "primary" },
    generation: 1,
    refresh: async () => ({ state: "available", routeGeneration: 1 }),
  }),
  invalidateTerminalEditors: vi.fn(),
}));
vi.mock("~/state/shell", () => ({
  shellEnvironment: {
    openInEditor: Object.assign(
      async (value: unknown) => {
        state.opened(value);
        return AsyncResult.success(undefined);
      },
      { permissionAtom: () => "editor-permission" },
    ),
  },
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => () => {} }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenPrLink: () => () => {} }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: {
    add: (value: unknown) => {
      state.toast(value);
      return "toast";
    },
    update: () => {},
    close: () => {},
  },
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: "Dialog",
  DialogDescription: "DialogDescription",
  DialogFooter: "DialogFooter",
  DialogHeader: "DialogHeader",
  DialogPanel: "DialogPanel",
  DialogPopup: "DialogPopup",
  DialogTitle: "DialogTitle",
}));
vi.mock("~/components/ui/group", () => ({ Group: "Group", GroupSeparator: "GroupSeparator" }));
vi.mock("~/components/ui/menu", () => ({
  Menu: "Menu",
  MenuItem: "MenuItem",
  MenuItemLabel: "MenuItemLabel",
  MenuPopup: "MenuPopup",
  MenuTrigger: "MenuTrigger",
}));
vi.mock("~/components/ui/popover", () => ({
  Popover: "Popover",
  PopoverPopup: "PopoverPopup",
  PopoverTrigger: "PopoverTrigger",
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: "Tooltip",
  TooltipPopup: "TooltipPopup",
  TooltipTrigger: "TooltipTrigger",
}));
vi.mock("~/components/ui/button", () => ({ Button: "Button" }));
vi.mock("~/components/ui/checkbox", () => ({ Checkbox: "Checkbox" }));
vi.mock("~/components/ui/input", () => ({ Input: "Input" }));
vi.mock("~/components/ui/radio-group", () => ({ RadioGroup: "RadioGroup" }));
vi.mock("~/components/ui/scroll-area", () => ({ ScrollArea: "ScrollArea" }));
vi.mock("~/components/ui/spinner", () => ({ Spinner: "Spinner" }));
vi.mock("~/components/ui/textarea", () => ({ Textarea: "Textarea" }));
vi.mock("~/components/ui/toggle", () => ({ toggleVariants: () => "" }));
vi.mock("./AnimatedHeight", () => ({ AnimatedHeight: "AnimatedHeight" }));

import GitActionsControl from "./GitActionsControl";

function renderActions() {
  GitActionsControl({
    gitCwd: "/repo",
    activeThreadRef: {
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    },
  });
  if (!state.run) throw new Error("Git action missing");
  return state.run;
}

describe("Git actions while thread details load", () => {
  beforeEach(() => {
    state.scopes = new Set([AuthSourceControlWriteScope]);
    state.primaryScopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
    state.shell = { branch: "main" };
    state.detail = null;
    state.draft = null;
    state.branch = "main";
    state.commits = 0;
    state.metadataRequests = [];
    state.afterGitAction = undefined;
    state.run = null;
  });

  it("does not create a feature branch for a server thread without task permission", async () => {
    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.branch).toBe("main");
    expect(state.commits).toBe(0);
    expect(state.shell?.branch).toBe("main");
  });

  it("commits and synchronizes the server thread before details finish loading", async () => {
    state.primaryScopes.clear();
    state.scopes.add(AuthOrchestrationOperateScope);
    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.branch).toBe("feature");
    expect(state.commits).toBe(1);
    expect(state.shell?.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("synchronizes archived thread detail after its shell disappears", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { branch: "main" };
    renderActions();
    state.shell = null;

    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.commits).toBe(1);
    expect(state.branch).toBe("feature");
    expect(state.detail.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("requires task permission before changing an archived thread's branch", async () => {
    state.shell = null;
    state.detail = { branch: "main" };

    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.commits).toBe(0);
    expect(state.detail.branch).toBe("main");
    expect(state.metadataRequests).toEqual([]);
  });

  it("uses the current shell branch when cached detail names the new branch", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { branch: "feature" };

    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.commits).toBe(1);
    expect(state.shell?.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("synchronizes a retained callback after the thread grant is gained", async () => {
    const run = renderActions();
    state.scopes.add(AuthOrchestrationOperateScope);
    await run({ action: "commit", featureBranch: true });
    expect(state.commits).toBe(1);
    expect(state.shell?.branch).toBe("feature");
    expect(state.metadataRequests).toHaveLength(1);
  });

  it.each([
    [AuthOrchestrationOperateScope, false],
    [AuthSourceControlWriteScope, true],
  ] as const)(
    "uses the fresh task grant after Git finishes, revoking %s",
    async (revokedScope, syncsThread) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      state.afterGitAction = () => state.scopes.delete(revokedScope);
      await renderActions()({ action: "commit", featureBranch: true });
      expect(state.commits).toBe(1);
      expect(state.branch).toBe("feature");
      expect(state.shell?.branch).toBe(syncsThread ? "feature" : "main");
      expect(state.metadataRequests).toHaveLength(syncsThread ? 1 : 0);
    },
  );

  it("keeps ordinary commits available while details load", async () => {
    await renderActions()({ action: "commit" });

    expect(state.commits).toBe(1);
    expect(state.branch).toBe("main");
  });

  it("keeps feature-branch commits available for a local draft", async () => {
    state.shell = null;
    state.draft = { branch: "main", worktreePath: null, envMode: "local" };
    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.commits).toBe(1);
    expect(state.draft.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([]);
  });
});

function changedFileButton() {
  const element = GitActionsControl({
    gitCwd: "/repo",
    activeThreadRef: {
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    },
  });
  type ButtonProps = {
    children?: ReactNode;
    "aria-label"?: string;
    disabled?: boolean;
    onClick?: () => void;
  };
  const find = (node: ReactNode): ButtonProps | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const match = find(child);
        if (match) return match;
      }
      return;
    }
    if (!isValidElement<ButtonProps>(node)) return;
    if (node.props["aria-label"] === "Open file.ts in editor") return node.props;
    return find(node.props.children);
  };
  const button = find(element);
  if (!button) throw new Error("Changed-file editor button is missing");
  return button;
}

it("opens changed files through authorized terminal and remote GUI routes and blocks local GUI after revocation", async () => {
  state.scopes = new Set([AuthTerminalOperateScope]);
  state.choice = { kind: "terminal", editor: "neovim" };
  state.remote = { mode: "local-exec" };
  state.opened.mockReset();
  state.toast.mockReset();
  vi.stubGlobal("window", {
    desktopBridge: {
      openTerminalEditor: async (input: unknown) => {
        state.opened(input);
        return { status: "opened" };
      },
    },
  });
  try {
    let completed: () => void = () => {};
    let milestone = new Promise<void>((resolve) => {
      completed = resolve;
    });
    state.opened.mockImplementation(() => completed());
    expect(changedFileButton().disabled).toBe(false);
    changedFileButton().onClick!();
    await milestone;
    expect(state.opened).toHaveBeenCalledWith(
      expect.objectContaining({
        editor: "neovim",
        target: expect.objectContaining({ path: "/repo/file.ts" }),
      }),
    );
    state.choice = { kind: "gui", editor: "vscode" };
    state.scopes.clear();
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "dev" } };
    milestone = new Promise<void>((resolve) => {
      completed = resolve;
    });
    expect(changedFileButton().disabled).toBe(false);
    changedFileButton().onClick!();
    await milestone;
    expect(state.opened).toHaveBeenCalledWith(
      expect.stringContaining("vscode://vscode-remote/ssh-remote+dev/repo/file.ts"),
    );
    state.remote = { mode: "local-exec" };
    state.scopes.add(AuthOrchestrationOperateScope);
    const retained = changedFileButton().onClick!;
    state.scopes.clear();
    state.opened.mockClear();
    expect(changedFileButton().disabled).toBe(true);
    milestone = new Promise<void>((resolve) => {
      completed = resolve;
    });
    state.toast.mockImplementation(() => completed());
    retained();
    await milestone;
    expect(state.opened).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to open file" }),
    );
    state.scopes.add(AuthOrchestrationOperateScope);
    milestone = new Promise<void>((resolve) => {
      completed = resolve;
    });
    expect(changedFileButton().disabled).toBe(false);
    changedFileButton().onClick!();
    await milestone;
    expect(state.opened).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment",
      input: { cwd: "/repo/file.ts", editor: "vscode" },
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
