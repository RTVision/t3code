import { RegistryContext } from "@effect/atom-react";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { act, type ReactNode, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
vi.mock("@t3tools/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const state = vi.hoisted(() => ({ writes: vi.fn(), refresh: vi.fn(), toast: vi.fn() }));
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
);
const setReaction = createEnvironmentRpcCommand(runtime, {
  label: "test.set-reaction",
  tag: WS_METHODS.pullRequestsSetReaction,
  execute: (input) =>
    Effect.promise(async () => {
      await state.writes(input);
    }),
});
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    get setReaction() {
      return setReaction;
    },
  },
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ render }: { render: ReactElement }) => render,
  PopoverPopup: () => null,
}));
import { PullRequestReactionBar } from "./PullRequestReactions";
const environmentId = EnvironmentId.make("reaction-permission");
const reference = { projectId: ProjectId.make("p"), repository: "owner/repo", number: 1 };
const session = (write: boolean): AuthSessionState => ({
  authenticated: true,
  scopes: write ? [AuthSourceControlWriteScope] : [],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
});
let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;
const render = (
  canReact = true,
  targetEnvironmentId = environmentId,
  subjectId = "gitea-comment-1",
) => (
  <RegistryContext.Provider value={registry}>
    <PullRequestReactionBar
      reactions={[{ content: "thumbs-up", count: 1, viewerHasReacted: false, actors: [] }]}
      canReact={canReact}
      subjectId={subjectId}
      environmentId={targetEnvironmentId}
      reference={reference}
      onRefresh={state.refresh}
    />
  </RegistryContext.Provider>
);
const pill = () =>
  renderer!.root
    .findAllByType("button")
    .find((button) => button.props["aria-label"]?.startsWith("thumbs up,"))!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  registry.set(sessions(environmentId), AsyncResult.success(session(false)));
  state.writes.mockReset().mockResolvedValue(undefined);
  state.refresh.mockReset();
  state.toast.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
});
it("preserves readable Gitea counts while denying optimistic updates, then reacts after regrant", async () => {
  await act(async () => {
    renderer = create(render());
  });
  const click = pill().props.onClick;
  expect(pill().props.disabled).toBe(true);
  expect(pill().props["aria-label"]).toBe("thumbs up, 1");
  await act(async () => click());
  expect(state.writes).not.toHaveBeenCalled();
  expect(pill().props["aria-label"]).toBe("thumbs up, 1");
  expect(pill().props["aria-pressed"]).toBe(false);
  expect(state.toast).not.toHaveBeenCalled();
  await act(async () => registry.set(sessions(environmentId), AsyncResult.success(session(true))));
  expect(pill().props.disabled).toBe(false);
  await act(async () => pill().props.onClick());
  expect(state.writes).toHaveBeenCalledExactlyOnceWith({
    ...reference,
    subjectId: "gitea-comment-1",
    content: "thumbs-up",
    reacted: true,
  });
  expect(state.refresh).toHaveBeenCalledOnce();
  expect(pill().props["aria-label"]).toBe("thumbs up, 2");
  expect(pill().props["aria-pressed"]).toBe(true);
});
it("rejects a retained reaction callback immediately after live revocation without optimistic marking", async () => {
  registry.set(sessions(environmentId), AsyncResult.success(session(true)));
  await act(async () => {
    renderer = create(render());
  });
  const click = pill().props.onClick;
  await act(async () => {
    registry.set(sessions(environmentId), AsyncResult.success(session(false)));
    click();
  });
  expect(state.writes).not.toHaveBeenCalled();
  expect(pill().props.disabled).toBe(true);
  expect(pill().props["aria-label"]).toBe("thumbs up, 1");
  expect(state.toast).not.toHaveBeenCalled();
});
it("rejects a retained callback when this host subject loses reaction support", async () => {
  registry.set(sessions(environmentId), AsyncResult.success(session(true)));
  await act(async () => {
    renderer = create(render());
  });
  const click = pill().props.onClick;
  await act(async () => renderer!.update(render(false)));
  await act(async () => click());
  expect(state.writes).not.toHaveBeenCalled();
  expect(pill().props.disabled).toBe(true);
  expect(pill().props["aria-label"]).toBe("thumbs up, 1");
});

it("uses the current destination grant and subject for a callback retained across a target switch", async () => {
  const nextEnvironmentId = EnvironmentId.make("reaction-next");
  registry.set(sessions(environmentId), AsyncResult.success(session(true)));
  registry.set(sessions(nextEnvironmentId), AsyncResult.success(session(false)));
  await act(async () => {
    renderer = create(render());
  });
  const click = pill().props.onClick;
  await act(async () => renderer!.update(render(true, nextEnvironmentId, "gitea-comment-2")));
  await act(async () => click());
  expect(state.writes).not.toHaveBeenCalled();
  expect(pill().props["aria-label"]).toBe("thumbs up, 1");
  await act(async () =>
    registry.set(sessions(nextEnvironmentId), AsyncResult.success(session(true))),
  );
  await act(async () => click());
  expect(state.writes).toHaveBeenCalledExactlyOnceWith({
    ...reference,
    subjectId: "gitea-comment-2",
    content: "thumbs-up",
    reacted: true,
  });
});
