import { act, createElement, useSyncExternalStore } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

const submission = Atom.make<"idle" | "pending" | "requested">("idle");
let registry: AtomRegistry.AtomRegistry;

const mocks = vi.hoisted(() => ({
  rerun: vi.fn(),
  invalidate: vi.fn(),
  jobs: vi.fn(),
  toast: vi.fn(),
  open: vi.fn(),
  pending: false,
}));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    ciRuns: () => "runs",
    ciJobs: (input: unknown) => {
      mocks.jobs(input);
      return "jobs";
    },
    rerunCi: "rerun",
    ciRerunState: () => submission,
    invalidate: "invalidate",
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<string>) =>
    useSyncExternalStore(
      (notify) => registry.subscribe(atom, notify),
      () => registry.get(atom),
    ),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "rerun" ? mocks.rerun : mocks.invalidate),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: string) => ({
    error: null,
    isPending: mocks.pending,
    refresh: vi.fn(),
    data:
      atom === "runs"
        ? {
            headSha: "head",
            truncated: false,
            runs: [
              {
                id: "12",
                name: "CI",
                url: "https://forge.test/run/12",
                status: "failure",
                attempt: 2,
                rerunModes: ["all", "failed"],
              },
            ],
          }
        : {
            jobs: [
              {
                id: "93",
                name: "Tests",
                url: "https://forge.test/jobs/999",
                status: "failure",
                canRerun: true,
              },
            ],
            truncated: false,
          },
  }),
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => mocks.open }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../ui/button", () => ({ Button: (props: object) => createElement("button", props) }));

import { PullRequestCiRuns } from "./PullRequestCiRuns";

const props = {
  environmentId: EnvironmentId.make("environment"),
  reference: { projectId: ProjectId.make("project"), repository: "acme/web", number: 42 },
};
let renderer: ReactTestRenderer;
const button = (label: string) =>
  renderer.root.findAllByType("button").find((node) => node.props.children === label)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.pending = false;
  registry = AtomRegistry.make();
  mocks.open.mockResolvedValue(undefined);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  registry.dispose();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("loads jobs only after expanding a run, and opens their host details", async () => {
  await act(async () => {
    renderer = create(<PullRequestCiRuns {...props} />);
  });
  expect(mocks.jobs).not.toHaveBeenCalled();
  await act(async () => button("CI").props.onClick());
  expect(mocks.jobs).toHaveBeenCalled();
  await act(async () => button("Tests").props.onClick());
  expect(mocks.open).toHaveBeenCalledWith("https://forge.test/jobs/999");
});

it("shows shared rerun progress and allows another request after CI refreshes", async () => {
  mocks.rerun.mockImplementation(async () => {
    registry.set(submission, "pending");
    return { _tag: "Success", value: undefined };
  });
  await act(async () => {
    renderer = create(<PullRequestCiRuns {...props} />);
  });
  await act(async () => {
    button("Rerun failed").props.onClick();
  });
  expect(mocks.rerun).toHaveBeenCalledTimes(1);
  expect(button("Rerun all").props.disabled).toBe(true);
  await act(async () => registry.set(submission, "requested"));
  expect(
    renderer.root
      .findAllByProps({ role: "status" })
      .some((node) => node.children.includes("Rerun requested")),
  ).toBe(true);
  expect(button("Rerun failed").props.disabled).toBe(true);
  await act(async () => registry.set(submission, "idle"));
  await act(async () => button("Rerun all").props.onClick());
  expect(mocks.rerun).toHaveBeenCalledTimes(2);
});

it("does not submit a rerun while the run data is refreshing", async () => {
  mocks.pending = true;
  await act(async () => {
    renderer = create(<PullRequestCiRuns {...props} />);
  });
  await act(async () => button("Rerun all").props.onClick());
  expect(mocks.rerun).not.toHaveBeenCalled();
  expect(button("Rerun all").props.disabled).toBe(true);
});
