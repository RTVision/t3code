import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  pullRequestSurface,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { usePanelPullRequestNavigation } from "./usePanelPullRequestNavigation";

const threadRef = scopeThreadRef("remote-environment" as EnvironmentId, ThreadId.make("thread"));
const threadPullRequest = pullRequestSurface({
  projectId: "thread-project",
  repository: "acme/web",
  number: 42,
});
const displayedPullRequest = pullRequestSurface({
  projectId: "linked-project",
  repository: "acme/api",
  number: 12,
});
let renderer: ReactTestRenderer | null = null;

function NavigationProbe({ surface }: { surface: RightPanelSurface | null }) {
  const openDependency = usePanelPullRequestNavigation(threadRef, surface, true);
  return <button onClick={() => openDependency(42)}>Open dependency</button>;
}

function activeSurface() {
  return selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ byThreadKey: {} });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("thread panel dependency navigation", () => {
  it("opens the dependency in the displayed repository and retains the thread's same-number PR", async () => {
    useRightPanelStore.getState().openPullRequest(threadRef, threadPullRequest);
    useRightPanelStore.getState().openPullRequest(threadRef, displayedPullRequest);
    await act(() => {
      renderer = create(<NavigationProbe surface={displayedPullRequest} />);
    });

    await act(() => renderer!.root.findByType("button").props.onClick());

    const dependency = pullRequestSurface({
      projectId: "linked-project",
      repository: "acme/api",
      number: 42,
    });
    expect(activeSurface()).toEqual(dependency);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([threadPullRequest, displayedPullRequest, dependency]);

    // Switching back to the thread's PR must also switch the dependency destination.
    useRightPanelStore.getState().activateSurface(threadRef, threadPullRequest.id);
    await act(() => renderer!.update(<NavigationProbe surface={threadPullRequest} />));
    await act(() => renderer!.root.findByType("button").props.onClick());
    expect(activeSurface()).toEqual(threadPullRequest);
  });

  it("uses the rendered repository while panel transitions retain the previous surface", async () => {
    useRightPanelStore.getState().openPullRequest(threadRef, displayedPullRequest);
    await act(() => {
      renderer = create(<NavigationProbe surface={displayedPullRequest} />);
    });
    useRightPanelStore.getState().openPullRequest(threadRef, threadPullRequest);

    await act(() => renderer!.root.findByType("button").props.onClick());

    expect(activeSurface()).toEqual(
      pullRequestSurface({ projectId: "linked-project", repository: "acme/api", number: 42 }),
    );
  });
});
