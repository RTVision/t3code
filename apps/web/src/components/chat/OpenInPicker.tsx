import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  EditorId,
  type EditorChoice,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { useEditorDispatch } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import { useRemoteOpenHint } from "../../remoteOpen";
import { useEnvironment } from "../../state/environments";
import { ChevronDownIcon, FolderClosedIcon, SquareArrowOutUpRightIcon } from "lucide-react";

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
import {
  AntigravityIcon,
  CursorIcon,
  FileExplorerIcon,
  FinderIcon,
  Icon,
  KiroIcon,
  NeovimIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useComposerMenuState } from "./useComposerMenuState";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  kind: "brand" | "generic";
};

export const resolveOpenInOptions = (
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
) => {
  const baseOptions: ReadonlyArray<Omit<OpenInOption, "label">> = [
    {
      Icon: CursorIcon,
      value: "cursor",
      kind: "brand",
    },
    {
      Icon: TraeIcon,
      value: "trae",
      kind: "brand",
    },
    {
      Icon: KiroIcon,
      value: "kiro",
      kind: "brand",
    },
    {
      Icon: VisualStudioCode,
      value: "vscode",
      kind: "brand",
    },
    {
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
      kind: "brand",
    },
    {
      Icon: VSCodium,
      value: "vscodium",
      kind: "brand",
    },
    {
      Icon: Zed,
      value: "zed",
      kind: "brand",
    },
    {
      Icon: AntigravityIcon,
      value: "antigravity",
      kind: "brand",
    },
    {
      Icon: IntelliJIdeaIcon,
      value: "idea",
      kind: "brand",
    },
    {
      Icon: AquaIcon,
      value: "aqua",
      kind: "brand",
    },
    {
      Icon: CLionIcon,
      value: "clion",
      kind: "brand",
    },
    {
      Icon: DataGripIcon,
      value: "datagrip",
      kind: "brand",
    },
    {
      Icon: DataSpellIcon,
      value: "dataspell",
      kind: "brand",
    },
    {
      Icon: GoLandIcon,
      value: "goland",
      kind: "brand",
    },
    {
      Icon: PhpStormIcon,
      value: "phpstorm",
      kind: "brand",
    },
    {
      Icon: PyCharmIcon,
      value: "pycharm",
      kind: "brand",
    },
    {
      Icon: RiderIcon,
      value: "rider",
      kind: "brand",
    },
    {
      Icon: RubyMineIcon,
      value: "rubymine",
      kind: "brand",
    },
    {
      Icon: RustRoverIcon,
      value: "rustrover",
      kind: "brand",
    },
    {
      Icon: WebStormIcon,
      value: "webstorm",
      kind: "brand",
    },
    {
      Icon: isMacPlatform(platform)
        ? FinderIcon
        : isWindowsPlatform(platform)
          ? FileExplorerIcon
          : FolderClosedIcon,
      value: "file-manager",
      kind: isMacPlatform(platform) || isWindowsPlatform(platform) ? "brand" : "generic",
    },
  ];
  const availableEditorSet = new Set(availableEditors);
  return baseOptions
    .filter((option) => availableEditorSet.has(option.value))
    .map((option) => ({ ...option, label: editorLabelForPlatform(option.value, platform) }));
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
  presentation = "toolbar",
  compact = false,
  enableShortcut = true,
  displayMode = "toolbar",
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  workspacePath?: string;
  presentation?: "toolbar" | "menu";
  compact?: boolean;
  enableShortcut?: boolean;
  displayMode?: "toolbar" | "panel";
}) {
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
  const environmentLabel = useEnvironment(environmentId)?.label ?? "this machine";
  const preferredEditor = dispatch.choice;
  const terminal = dispatch.terminal.capability;
  const terminalVisible =
    terminal.state === "available" ||
    terminal.state === "check-on-open" ||
    preferredEditor?.kind === "terminal";
  const options = useMemo(
    () => resolveOpenInOptions(navigator.platform, dispatch.effectiveEditors),
    [dispatch.effectiveEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor?.editor) ?? null;
  const canOpenEditor = preferredEditor?.kind === "terminal" ? canOperateTerminal : canOpenGui;
  const density = presentation === "menu" ? "touch" : "default";
  const openInEditor = useCallback(
    async (editor: EditorChoice | null, explicit = false) => {
      if (!openInCwd || !editor) return;
      if (
        editor.kind === "terminal"
          ? !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
          : !canOpenGui
      )
        return;
      const result = await dispatch.open(
        { kind: compact ? "file" : "directory", path: openInCwd },
        editor,
      );
      if (isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to open editor",
          description: error instanceof Error ? error.message : "The editor could not be opened.",
        });
      } else {
        if (explicit) dispatch.select(editor);
        if (remote.mode === "remote-links") markRemoteHintSeen();
      }
    },
    [canOpenGui, compact, dispatch, environmentId, markRemoteHintSeen, openInCwd, remote.mode],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    if (!enableShortcut || !canOpenEditor) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!openInCwd) return;
      if (!preferredEditor) return;
      e.preventDefault();
      void openInEditor(preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canOpenEditor, enableShortcut, keybindings, openInCwd, openInEditor, preferredEditor]);
  const toolbarLabel = isPanel
    ? `Open in ${preferredEditor?.kind === "terminal" ? "Neovim (Terminal)" : (primaryOption?.label ?? "editor")}`
    : "Open";

  const editorItems = (
    <>
      {terminalVisible && (
        <MenuItem
          density={density}
          disabled={!openInCwd || !canOperateTerminal}
          onClick={() => openInEditor({ kind: "terminal", editor: "neovim" }, true)}
        >
          <NeovimIcon aria-hidden="true" />
          <MenuItemLabel>Neovim (Terminal)</MenuItemLabel>
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
          Rescan Neovim
        </MenuItem>
      )}
      {remote.mode === "remote-unavailable" ? (
        <MenuItem density={density} disabled>
          No SSH route to {environmentLabel}
        </MenuItem>
      ) : (
        <>
          {options.length === 0 && (
            <MenuItem density={density} disabled>
              No installed editors found
            </MenuItem>
          )}
          {options.map(({ label, Icon, value, kind }) => (
            <MenuItem
              density={density}
              disabled={!openInCwd || !canOpenGui}
              key={value}
              onClick={() => openInEditor({ kind: "gui", editor: value }, true)}
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
              Opens over SSH. Needs your key on {environmentLabel}
            </MenuItem>
          )}
        </>
      )}
      <MenuItem density={density} render={<Link to="/settings/editors" />}>
        Editor settings…
      </MenuItem>
    </>
  );
  const primaryDisabled =
    !preferredEditor ||
    !openInCwd ||
    !canOpenEditor ||
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
            <MenuItemLabel>Open in {primaryLabel}</MenuItemLabel>
            {openFavoriteEditorShortcutLabel && (
              <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
            )}
          </MenuItem>
        )}
        <MenuSub>
          <MenuSubTrigger density="touch" disabled={isEditorMenuDenied}>
            <SquareArrowOutUpRightIcon className="size-4" />
            <MenuItemLabel>Open in…</MenuItemLabel>
          </MenuSubTrigger>
          <MenuSubPopup>{editorItems}</MenuSubPopup>
        </MenuSub>
      </>
    );
  }

  return (
    <ActionGroup
      aria-label="Open in editor"
      role="group"
      {...(isPanel
        ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
        : {})}
    >
      <ThreadDetailsControl
        aria-label={compact ? "Open file in preferred editor" : toolbarLabel}
        size={isPanel ? "sm" : "xs"}
        variant={isPanel ? "ghost" : "outline"}
        part="primary"
        panel={isPanel}
        disabled={primaryDisabled}
        title={preferredEditor?.kind === "terminal" ? terminal.message : undefined}
        onClick={() => openInEditor(preferredEditor)}
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
          <SquareArrowOutUpRightIcon
            aria-hidden="true"
            className={THREAD_DETAILS_PANEL_ICON_CLASS}
          />
        ) : null}
        <span
          className={cn(
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
            isPanel && "not-sr-only ml-0 min-w-0 truncate",
          )}
        >
          {toolbarLabel}
        </span>
      </ThreadDetailsControl>
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
        <MenuTrigger
          disabled={isEditorMenuDenied}
          render={
            <ThreadDetailsControl
              aria-label="Choose editor"
              size={isPanel ? "sm" : "icon-xs"}
              variant={isPanel ? "ghost" : "outline"}
              part="secondary"
              panel={isPanel}
            />
          }
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
          />
        </MenuTrigger>
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
