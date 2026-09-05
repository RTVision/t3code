import {
  EditorId,
  type EditorChoice,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { useEditorDispatch } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import { useRemoteOpenHint } from "../../remoteOpen";
import { useEnvironment } from "../../state/environments";
import { ChevronDownIcon, FolderClosedIcon, TerminalIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  Icon,
  KiroIcon,
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
import { cn } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  kind: "brand" | "generic";
};

const resolveOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
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
      Icon: FolderClosedIcon,
      value: "file-manager",
      kind: "generic",
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
  compact = false,
  enableShortcut = true,
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  workspacePath?: string;
  compact?: boolean;
  enableShortcut?: boolean;
}) {
  const dispatch = useEditorDispatch(
    environmentId,
    availableEditors,
    workspacePath ?? (compact ? undefined : openInCwd),
  );
  const remote = dispatch.remote.state;
  const [remoteHintSeen, markRemoteHintSeen] = useRemoteOpenHint();
  const environmentLabel = useEnvironment(environmentId)?.label ?? "this machine";
  const preferredEditor = dispatch.choice;
  const terminal = dispatch.terminal.capability;
  const terminalVisible =
    terminal.state === "available" ||
    terminal.state === "check-on-open" ||
    preferredEditor?.kind === "terminal";
  const options = useMemo(
    () => resolveOptions(navigator.platform, dispatch.effectiveEditors),
    [dispatch.effectiveEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor?.editor) ?? null;
  const openInEditor = useCallback(
    async (editor: EditorChoice | null, explicit = false) => {
      if (!openInCwd || !editor) return;
      if (explicit) dispatch.select(editor);
      const result = await dispatch.open(
        { kind: compact ? "file" : "directory", path: openInCwd },
        editor,
      );
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to open editor",
          description: error instanceof Error ? error.message : "The editor could not be opened.",
        });
      } else if (remote.mode === "remote-links") markRemoteHintSeen();
    },
    [compact, dispatch, markRemoteHintSeen, openInCwd, remote.mode],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    if (!enableShortcut) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!openInCwd) return;
      if (!preferredEditor) return;

      e.preventDefault();
      void openInEditor(preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enableShortcut, keybindings, openInCwd, openInEditor, preferredEditor]);

  return (
    <Group aria-label="Open in editor">
      <Button
        aria-label={compact ? "Open file in preferred editor" : undefined}
        className="ps-[8.5px]"
        size="xs"
        variant="outline"
        disabled={
          !preferredEditor ||
          !openInCwd ||
          (preferredEditor.kind === "gui" && remote.mode === "remote-unavailable")
        }
        title={preferredEditor?.kind === "terminal" ? terminal.message : undefined}
        onClick={() => openInEditor(preferredEditor)}
      >
        {preferredEditor?.kind === "terminal" && (
          <TerminalIcon aria-hidden="true" className="size-3.5" />
        )}
        {primaryOption?.Icon && (
          <primaryOption.Icon
            aria-hidden="true"
            className={cn("size-3.5", getOpenInIconClass(primaryOption.kind))}
          />
        )}
        <span
          className={
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5"
          }
        >
          Open
        </span>
      </Button>
      <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={compact ? "Choose editor" : "Copy options"}
              size="icon-xs"
              variant="outline"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {terminalVisible && (
            <MenuItem onClick={() => openInEditor({ kind: "terminal", editor: "neovim" }, true)}>
              <TerminalIcon aria-hidden="true" />
              Neovim (Terminal)
              {preferredEditor?.kind === "terminal" && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          )}
          {terminalVisible && terminal.state !== "available" && (
            <MenuItem disabled className="max-w-80 whitespace-normal">
              {terminal.message}
            </MenuItem>
          )}
          {terminalVisible && (
            <MenuItem onClick={() => void dispatch.terminal.rescan()}>Rescan Neovim</MenuItem>
          )}
          {remote.mode === "remote-unavailable" ? (
            <MenuItem disabled>No SSH route to {environmentLabel}</MenuItem>
          ) : (
            <>
              {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
              {options.map(({ label, Icon, value, kind }) => (
                <MenuItem
                  key={value}
                  onClick={() => openInEditor({ kind: "gui", editor: value }, true)}
                >
                  <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
                  {label}
                  {value === preferredEditor?.editor && openFavoriteEditorShortcutLabel && (
                    <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
                  )}
                </MenuItem>
              ))}
              {remote.mode === "remote-links" && !remoteHintSeen && (
                <MenuItem disabled>Opens over SSH. Needs your key on {environmentLabel}</MenuItem>
              )}
            </>
          )}
          <MenuItem render={<Link to="/settings/editors" />}>Editor settings…</MenuItem>
        </MenuPopup>
      </Menu>
    </Group>
  );
});
