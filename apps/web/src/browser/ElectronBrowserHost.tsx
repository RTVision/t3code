import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  type DesktopPreviewBridge,
  type DesktopPreviewOpenLinkEvent,
  type EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { type ComponentProps, useEffect } from "react";

import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { isElectron } from "~/env";
import { useClientSettingsHydrated } from "~/hooks/useSettings";
import { useDesktopHostedPreviewSessions } from "~/components/preview/usePreviewSession";
import {
  pinPreviewDesktopProfile,
  readActivePreviewSessions,
  type ThreadPreviewState,
  useActivePreviewSessions,
} from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserDefaults } from "./browserDefaults";
import { useBrowserPointerStore } from "./browserPointerStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { openUrlInPreview } from "./openFileInPreview";
import { rendersServerTabNatively } from "./previewRuntime";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

/** Every session this window renders as a hosted webview, in a fixed (non-display) order. */
function hostedBrowserSessions(
  previewByThreadKey: Record<string, ThreadPreviewState>,
  primaryEnvironmentId: EnvironmentId | null,
) {
  const activeSessions = Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef
      ? Object.values(previewState.sessions)
          .filter(
            (snapshot) =>
              snapshot.runtime !== "server" ||
              rendersServerTabNatively(threadRef.environmentId, primaryEnvironmentId, snapshot),
          )
          .map((snapshot) => ({
            threadRef,
            snapshot,
            runtimeTabId: previewRuntimeTabId(threadRef, previewState.serverEpoch, snapshot.tabId),
            serverEpoch: previewState.serverEpoch,
            profileId: previewState.desktopProfileByTabId?.[snapshot.tabId],
            pictureInPicture:
              previewState.desktopByTabId[snapshot.tabId]?.pictureInPicture ?? false,
            zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
          }))
      : [];
  });
  // Electron destroys a moved webview's guest, so the render order must not follow the server's
  // updatedAt order. Any fixed order works; this one is not a display order.
  return activeSessions.toSorted((left, right) =>
    left.runtimeTabId < right.runtimeTabId ? -1 : left.runtimeTabId > right.runtimeTabId ? 1 : 0,
  );
}

function startAnnotationThemeSync(preview: DesktopPreviewBridge): () => void {
  let lastSerializedTheme = "";
  const syncTheme = () => {
    const theme = readPreviewAnnotationTheme();
    const serializedTheme = JSON.stringify(theme);
    if (serializedTheme === lastSerializedTheme) return;
    lastSerializedTheme = serializedTheme;
    void preview.setAnnotationTheme(theme).catch(() => {
      lastSerializedTheme = "";
    });
  };
  // App services start before the first paint, when the theme styles may not be applied yet.
  const frameId = window.requestAnimationFrame(syncTheme);
  const observer = new MutationObserver(syncTheme);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  const headObserver = new MutationObserver(syncTheme);
  headObserver.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return () => {
    window.cancelAnimationFrame(frameId);
    observer.disconnect();
    headObserver.disconnect();
  };
}

function openLinkInPreview({ tabId, url, background }: DesktopPreviewOpenLinkEvent): void {
  const source = hostedBrowserSessions(
    readActivePreviewSessions(),
    appAtomRegistry.get(primaryEnvironmentIdAtom),
  ).find((session) => session.runtimeTabId === tabId);
  if (!source || source.profileId === undefined) return;
  void openUrlInPreview({
    threadRef: source.threadRef,
    url,
    openPreview: (input) => runAtomCommand(appAtomRegistry, previewEnvironment.open, input),
    profileId: source.profileId,
    background,
  });
}

/** App-lifetime listeners for the desktop preview bridge: annotation theme, agent pointer, links. */
export function startElectronBrowserHost(): () => void {
  const preview = window.desktopBridge?.preview;
  if (!preview) return () => {};
  const disposers = [
    startAnnotationThemeSync(preview),
    preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
    }),
    // Older desktop bridges have no link events.
    ...(preview.onOpenLink ? [preview.onOpenLink(openLinkInPreview)] : []),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export function ElectronBrowserHost() {
  const previewByThreadKey = useActivePreviewSessions();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const hydrated = useClientSettingsHydrated();
  const defaultProfileId = useBrowserDefaults().profileId;
  useDesktopHostedPreviewSessions(primaryEnvironmentId);
  const sessions = hostedBrowserSessions(previewByThreadKey, primaryEnvironmentId);
  // Persist a desktop profile before Electron attaches the guest partition.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Partition selection must be latched imperatively.
  useEffect(() => {
    if (!isElectron || !hydrated) return;
    for (const session of sessions) {
      if (session.profileId !== undefined) continue;
      pinPreviewDesktopProfile(
        session.threadRef,
        session.serverEpoch,
        session.snapshot.tabId,
        session.snapshot.profileId ?? defaultProfileId,
      );
    }
  }, [defaultProfileId, hydrated, sessions]);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {sessions.map(
        ({ threadRef, snapshot, runtimeTabId, pictureInPicture, zoomFactor, profileId }) => {
          const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
          return (
            <AuthorizedBrowserWebview
              key={runtimeTabId}
              threadRef={threadRef}
              tabId={snapshot.tabId}
              runtimeTabId={runtimeTabId}
              initialUrl={url}
              viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
              pictureInPicture={pictureInPicture}
              profileId={profileId}
              zoomFactor={zoomFactor}
              serverDriven={snapshot.runtime === "server"}
              {...(snapshot.runtime === "server"
                ? {
                    serverRendering: {
                      colorScheme: snapshot.colorScheme ?? "system",
                      zoomFactor: snapshot.zoomFactor ?? 1,
                    },
                  }
                : {})}
            />
          );
        },
      )}
    </div>
  );
}

function AuthorizedBrowserWebview(props: ComponentProps<typeof HostedBrowserWebview>) {
  const canOperatePreview = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthPreviewOperateScope,
  );
  return canOperatePreview && props.profileId !== undefined ? (
    <HostedBrowserWebview {...props} />
  ) : null;
}
