import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  EditorId,
  type EditorChoice,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { memo, use, useRef } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { shortcutLabelForCommand } from "../../keybindings";
import type { FileManagerAction } from "./OpenInPicker.logic";
import { OPEN_FAVORITE_EDITOR_ATTRIBUTE } from "./OpenInPickerShortcut";
import { useEditorDispatch } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import type { MessageResolver } from "../../i18n/messages";
import { useRemoteOpenHint } from "../../remoteOpen";
import { useEnvironment } from "../../state/environments";
import { ChevronDownIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuTrigger,
} from "../ui/menu";
import { NeovimIcon } from "../Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type EditorIconOption, editorIconOptions } from "../editorIcons";
import { announce } from "~/lib/announce";
import { cn } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useComposerMenuState } from "./useComposerMenuState";

type OpenInOption = EditorIconOption & { label: string };

const resolveOpenInOptions = (
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
  resolve: MessageResolver,
): ReadonlyArray<OpenInOption> => {
  const availableEditorSet = new Set(availableEditors);
  return editorIconOptions(platform)
    .filter((option) => availableEditorSet.has(option.value))
    .map((option) => ({
      ...option,
      label: editorLabelForPlatform(option.value, platform, resolve),
    }));
};
function getOpenInIconClass(kind: OpenInOption["kind"]) {
  return cn(kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground");
}
export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  workspacePath,
  openInCwdIsFile,
  presentation = "toolbar",
  compact = false,
  enableShortcut = true,
  displayMode = "toolbar",
  fileManagerAction = "open",
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  workspacePath?: string;
  openInCwdIsFile?: boolean;
  presentation?: "toolbar" | "menu";
  compact?: boolean;
  enableShortcut?: boolean;
  displayMode?: "toolbar" | "panel";
  fileManagerAction?: FileManagerAction;
}) {
  const gt = useGT();
  const messages = useMessages();
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const panelAnchorRef = useRef<HTMLDivElement | null>(null);
  const dispatch = useEditorDispatch(
    environmentId,
    availableEditors,
    workspacePath ?? (compact ? undefined : openInCwd),
  );
  const remote = dispatch.remote.state;
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canOpenGui =
    remote.mode !== "remote-unavailable" && (remote.mode !== "local-exec" || canOperateHost);
  const isEditorMenuDenied = !canOpenGui && !canOperateTerminal;
  const [menuOpen, setMenuOpen] = useComposerMenuState(isEditorMenuDenied);
  const [remoteHintSeen, markRemoteHintSeen] = useRemoteOpenHint();
  const environmentLabel = useEnvironment(environmentId)?.label ?? null;
  const preferredEditor = dispatch.choice;
  const terminal = dispatch.terminal.capability;
  const terminalVisible =
    terminal.state === "available" ||
    terminal.state === "check-on-open" ||
    preferredEditor?.kind === "terminal";
  const options = resolveOpenInOptions(navigator.platform, dispatch.effectiveEditors, messages);
  const primaryOption = options.find(({ value }) => value === preferredEditor?.editor) ?? null;
  const canOpenEditor = preferredEditor?.kind === "terminal" ? canOperateTerminal : canOpenGui;
  const density = presentation === "menu" ? "touch" : "default";
  const isEditorUnavailable = (editor: EditorChoice["editor"]) =>
    editor === "file-manager" && fileManagerAction === "unavailable";
  const openInEditor = async (editor: EditorChoice | null, explicit = false): Promise<boolean> => {
    if (!openInCwd || !editor || isEditorUnavailable(editor.editor)) return false;
    if (
      editor.kind === "terminal"
        ? !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
        : !canOpenGui
    )
      return false;
    const result = await dispatch.open(
      { kind: (openInCwdIsFile ?? compact) ? "file" : "directory", path: openInCwd },
      editor,
      { reveal: fileManagerAction === "reveal" && editor.editor === "file-manager" },
    );
    if (isAtomCommandInterrupted(result)) return false;
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Unable to open editor"),
        description: error instanceof Error ? error.message : gt("The editor could not be opened."),
      });
      return false;
    }
    if (explicit) dispatch.select(editor);
    if (remote.mode === "remote-links") markRemoteHintSeen();
    return true;
  };
  const openFavoriteEditorShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "editor.openFavorite",
  );

  const backgroundThread = use(BackgroundThreadContext);
  const toolbarLabel = isPanel
    ? preferredEditor?.kind === "terminal" || primaryOption
      ? gt("Open in {editor}", {
          editor: preferredEditor?.kind === "terminal" ? "Neovim (Terminal)" : primaryOption!.label,
        })
      : gt("Open in editor")
    : gt("Open", { $context: "verb, opens the project in the preferred editor" });
  const unavailableReason =
    remote.mode === "remote-unavailable"
      ? environmentLabel !== null
        ? gt("No SSH route to {environment}", { environment: environmentLabel })
        : gt("No SSH route to this machine")
      : remote.mode === "remote-links" && options.length === 0
        ? environmentLabel !== null
          ? gt("Open from a computer to edit on {environment}", { environment: environmentLabel })
          : gt("Open from a computer to edit on this machine")
        : null;
  const editorItems = (
    <>
      {terminalVisible && (
        <MenuItem
          density={density}
          disabled={!openInCwd || !canOperateTerminal}
          onClick={() => openInEditor({ kind: "terminal", editor: "neovim" }, true)}
        >
          <NeovimIcon aria-hidden="true" />
          <MenuItemLabel>
            <T>Neovim (Terminal)</T>
          </MenuItemLabel>
          {preferredEditor?.kind === "terminal" && openFavoriteEditorShortcutLabel && (
            <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
          )}
        </MenuItem>
      )}
      {terminalVisible && terminal.state !== "available" && (
        <MenuItem density={density} disabled className="max-w-80 whitespace-normal">
          {terminal.message}
        </MenuItem>
      )}
      {terminalVisible && (
        <MenuItem
          density={density}
          disabled={!canOperateTerminal}
          onClick={() => void dispatch.terminal.rescan()}
        >
          <T>Rescan Neovim</T>
        </MenuItem>
      )}
      {unavailableReason !== null ? (
        <MenuItem density={density} disabled>
          {unavailableReason}
        </MenuItem>
      ) : (
        <>
          {options.length === 0 && (
            <MenuItem density={density} disabled>
              <T>No installed editors found</T>
            </MenuItem>
          )}
          {options.map(({ label, Icon, value, kind }) => (
            <MenuItem
              density={density}
              disabled={
                !openInCwd || !canOpenGui || (presentation === "menu" && isEditorUnavailable(value))
              }
              key={value}
              onClick={() => {
                const choice = { kind: "gui", editor: value } as const;
                if (presentation === "menu") {
                  void openInEditor(choice, true);
                } else {
                  dispatch.select(choice);
                }
              }}
            >
              <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
              <MenuItemLabel>{label}</MenuItemLabel>
              {value === preferredEditor?.editor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
          {remote.mode === "remote-links" && !remoteHintSeen && (
            <MenuItem density={density} disabled>
              {environmentLabel !== null
                ? gt("Opens over SSH. Needs your key on {environment}", {
                    environment: environmentLabel,
                  })
                : gt("Opens over SSH. Needs your key on this machine")}
            </MenuItem>
          )}
        </>
      )}
      <MenuItem density={density} render={<Link to="/settings/editors" />}>
        <T>Editor settings…</T>
      </MenuItem>
    </>
  );
  const primaryDisabled =
    !preferredEditor ||
    !openInCwd ||
    !canOpenEditor ||
    isEditorUnavailable(preferredEditor.editor) ||
    (preferredEditor.kind === "gui" && remote.mode === "remote-unavailable");
  const primaryLabel =
    preferredEditor?.kind === "terminal" ? "Neovim (Terminal)" : primaryOption?.label;
  if (presentation === "menu") {
    return (
      <>
        {primaryLabel && (
          <MenuItem
            density={density}
            disabled={primaryDisabled}
            onClick={() => openInEditor(preferredEditor)}
          >
            {preferredEditor?.kind === "terminal" ? (
              <NeovimIcon className="size-4" />
            ) : (
              primaryOption && (
                <primaryOption.Icon
                  className={cn("size-4", getOpenInIconClass(primaryOption.kind))}
                />
              )
            )}
            <MenuItemLabel>
              <T>
                Open in <Var>{primaryLabel}</Var>
              </T>
            </MenuItemLabel>
            {openFavoriteEditorShortcutLabel && (
              <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
            )}
          </MenuItem>
        )}
        <MenuSub>
          <MenuSubTrigger density="touch" disabled={isEditorMenuDenied}>
            <SquareArrowOutUpRightIcon className="size-4" />
            <MenuItemLabel>
              <T>Open in…</T>
            </MenuItemLabel>
          </MenuSubTrigger>
          <MenuSubPopup>{editorItems}</MenuSubPopup>
        </MenuSub>
      </>
    );
  }
  const primaryControlLabel = compact ? gt("Open file in preferred editor") : toolbarLabel;
  const primaryControl = (
    <ThreadDetailsControl
      aria-label={primaryControlLabel}
      data-toolbar-control=""
      size={isPanel ? "sm" : "xs"}
      variant={isPanel ? "ghost" : "outline"}
      part="primary"
      panel={isPanel}
      disabled={primaryDisabled}
      title={preferredEditor?.kind === "terminal" ? terminal.message : undefined}
      {...(enableShortcut && !backgroundThread ? { [OPEN_FAVORITE_EDITOR_ATTRIBUTE]: "" } : {})}
      onClick={() => {
        if (!preferredEditor) return;
        const label = editorLabelForPlatform(preferredEditor.editor, navigator.platform);
        void openInEditor(preferredEditor).then((opened) => {
          if (opened) announce(gt("Opened in {editor}", { editor: label }));
        });
      }}
    >
      {preferredEditor?.kind === "terminal" ? (
        <NeovimIcon
          aria-hidden="true"
          className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3.5"}
        />
      ) : primaryOption?.Icon ? (
        <primaryOption.Icon
          aria-hidden="true"
          className={cn(
            isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3.5",
            getOpenInIconClass(primaryOption.kind),
          )}
        />
      ) : isPanel ? (
        <SquareArrowOutUpRightIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      ) : null}
      <span
        className={cn(
          compact
            ? "sr-only"
            : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
          isPanel && cn("not-sr-only ml-0 min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
        )}
      >
        {toolbarLabel}
      </span>
    </ThreadDetailsControl>
  );
  return (
    <ActionGroup
      aria-label={gt("Open in editor")}
      role="group"
      {...(isPanel
        ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
        : {})}
    >
      <Tooltip>
        <TooltipTrigger render={primaryControl} />
        <TooltipPopup side="top">{primaryControlLabel}</TooltipPopup>
      </Tooltip>
      {isPanel ? (
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      ) : (
        <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      )}
      <Menu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) void dispatch.terminal.refresh();
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                disabled={isEditorMenuDenied}
                render={
                  <ThreadDetailsControl
                    aria-label={gt("Choose editor")}
                    data-toolbar-control=""
                    size={isPanel ? "sm" : "icon-xs"}
                    variant={isPanel ? "ghost" : "outline"}
                    part="secondary"
                    panel={isPanel}
                  />
                }
              />
            }
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{gt("Choose editor")}</TooltipPopup>
        </Tooltip>
        <MenuPopup
          align="end"
          {...(isPanel ? { anchor: panelAnchorRef } : {})}
          className={isPanel ? "w-(--anchor-width)" : undefined}
        >
          {editorItems}
        </MenuPopup>
      </Menu>
    </ActionGroup>
  );
});
