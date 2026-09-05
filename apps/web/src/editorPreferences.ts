import {
  EDITORS,
  EditorChoice,
  EditorId,
  EnvironmentId,
  buildRemoteOpenUrl,
  type EditorOpenTarget,
} from "@t3tools/contracts";
import {
  editorTargetFromLegacy,
  editorWorkspace,
  guiEditorTarget,
  resolveEditorChoice,
} from "@t3tools/client-runtime/editor-choice";
import { mapAtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { getLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useCallback, useEffect } from "react";
import { randomUUID } from "./lib/utils";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenResolution,
} from "./remoteOpen";
import { invalidateTerminalEditors, useTerminalEditor } from "./terminalEditors";

const NullableEditorId = Schema.NullOr(EditorId);
const NullableEditorChoice = Schema.NullOr(EditorChoice);
const LAST_EDITOR_KEY = "t3code:last-editor";
export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedErrorClass<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  { targetPath: Schema.String },
) {
  override get message() {
    return `Cannot open ${this.targetPath} because no environment is selected.`;
  }
}
export class PreferredEditorUnavailableError extends Schema.TaggedErrorClass<PreferredEditorUnavailableError>()(
  "PreferredEditorUnavailableError",
  {
    environmentId: EnvironmentId,
    targetPath: Schema.String,
    availableEditorIds: Schema.Array(EditorId),
  },
) {
  override get message() {
    return `No available editor can open ${this.targetPath} in environment ${this.environmentId}.`;
  }
}
export class EditorOpenError extends Schema.TaggedErrorClass<EditorOpenError>()("EditorOpenError", {
  message: Schema.String,
}) {}

export function useEditorChoice(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const terminal = useTerminalEditor(environmentId);
  const remote = useRemoteOpenResolution(environmentId);
  const remoteEditors = useRemoteCapableEditors();
  const effectiveEditors = remote.state.mode === "local-exec" ? availableEditors : remoteEditors;
  const [legacy] = useLocalStorage<EditorId | null, EditorId | null>(
    LAST_EDITOR_KEY,
    null,
    NullableEditorId,
  );
  const [fallback, setFallback] = useLocalStorage<EditorChoice | null, EditorChoice | null>(
    "t3code:editor-choice:v1",
    null,
    NullableEditorChoice,
  );
  const [routeKey, setRouteKey] = useLocalStorage(
    `t3code:editor-route:v1:${environmentId ?? "none"}`,
    "",
    Schema.String,
  );
  useEffect(() => {
    if (!fallback && legacy) setFallback({ kind: "gui", editor: legacy });
  }, [fallback, legacy, setFallback]);
  const currentRouteKey = terminal.capability.preferenceKey || routeKey;
  useEffect(() => {
    if (terminal.capability.preferenceKey && routeKey !== terminal.capability.preferenceKey)
      setRouteKey(terminal.capability.preferenceKey);
  }, [terminal.capability.preferenceKey, routeKey, setRouteKey]);
  const [explicit, select] = useLocalStorage<EditorChoice | null, EditorChoice | null>(
    `t3code:editor-choice:v1:${environmentId ?? "none"}:${currentRouteKey}`,
    null,
    NullableEditorChoice,
  );
  const choice = resolveEditorChoice(explicit, fallback, legacy, effectiveEditors);
  return { choice, select, effectiveEditors, terminal, remote };
}

// Retained for menu labels and mixed-version callers; all launches use the dispatch hook below.
export function usePreferredEditor(
  availableEditors: readonly EditorId[],
  environmentId: EnvironmentId | null = null,
) {
  const state = useEditorChoice(environmentId, availableEditors);
  return [
    state.choice?.editor ?? null,
    (editor: EditorId) => state.select({ kind: "gui", editor }),
  ] as const;
}
export function resolvePreferredEditor(availableEditors: readonly EditorId[]): EditorId | null {
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  return stored && availableEditors.includes(stored)
    ? stored
    : (EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null);
}

export function useEditorDispatch(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
  workspace?: string | null,
) {
  const state = useEditorChoice(environmentId, availableEditors);
  const openGui = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const { choice, terminal, remote } = state;
  const open = useCallback(
    async (input: string | EditorOpenTarget, selected: EditorChoice | null = choice) => {
      const target = typeof input === "string" ? editorTargetFromLegacy(input) : input;
      if (!environmentId)
        return AsyncResult.failure(
          Cause.fail(new PreferredEditorEnvironmentRequiredError({ targetPath: target.path })),
        );
      if (!selected)
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorUnavailableError({
              environmentId,
              targetPath: target.path,
              availableEditorIds: availableEditors,
            }),
          ),
        );
      try {
        if (selected.kind === "terminal") {
          const bridge = window.desktopBridge?.openTerminalEditor;
          if (!bridge)
            throw new EditorOpenError({
              message: "Neovim (Terminal) requires a desktop app with terminal editor support.",
            });
          if (!terminal.connected || !terminal.connection)
            throw new EditorOpenError({
              message: "Connect this environment before opening Neovim.",
            });
          const capability = await terminal.refresh();
          if (capability.state !== "available" && capability.state !== "check-on-open")
            throw new EditorOpenError({ message: capability.message });
          const result = await bridge({
            connection: terminal.connection,
            connectionGeneration: terminal.generation,
            requestId: randomUUID(),
            routeGeneration: capability.routeGeneration,
            editor: "neovim",
            workspacePath: editorWorkspace(target, workspace),
            target,
          });
          if (result.status === "failed") {
            invalidateTerminalEditors();
            throw new EditorOpenError({ message: result.message });
          }
          return AsyncResult.success("neovim" as const);
        }
        if (!remote.isResolved)
          throw new EditorOpenError({
            message: "The environment's editor route is still resolving.",
          });
        if (remote.state.mode === "remote-unavailable")
          throw new EditorOpenError({
            message: "No SSH editor route is available for this environment.",
          });
        if (remote.state.mode === "remote-links") {
          const url = buildRemoteOpenUrl({
            editor: selected.editor,
            host: remote.state.host.host,
            absolutePath: guiEditorTarget(target),
          });
          if (!url || !(await openRemoteEditorUrl(url)))
            throw new EditorOpenError({
              message: "The desktop could not open this remote editor link.",
            });
          return AsyncResult.success(selected.editor);
        }
        return mapAtomCommandResult(
          await openGui({
            environmentId,
            input: { cwd: guiEditorTarget(target), editor: selected.editor },
          }),
          () => selected.editor,
        );
      } catch (error) {
        return AsyncResult.failure(
          Cause.fail(
            new EditorOpenError({
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }
    },
    [availableEditors, choice, environmentId, openGui, remote, terminal, workspace],
  );
  return { ...state, open };
}
export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
  workspace?: string | null,
) {
  return useEditorDispatch(environmentId, availableEditors, workspace).open;
}
