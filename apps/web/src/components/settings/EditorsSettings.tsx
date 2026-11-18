import { useGT, T } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { EDITORS } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useEditorChoice } from "../../editorPreferences";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function EditorsSettingsPanel() {
  const gt = useGT();
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [selectedEnvironment, setSelectedEnvironment] = useState<string | null>(null);
  const environmentId =
    environments.find((environment) => environment.environmentId === selectedEnvironment)
      ?.environmentId ?? primary;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const state = useEditorChoice(environmentId, config?.availableEditors ?? []);
  const { capability, connection, refresh } = state.terminal;
  // Refresh the selected environment when the settings surface opens or changes.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The capability is discovered asynchronously.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const draftKey = `${environmentId}:${capability.preferenceKey}`;
  const [draft, setDraft] = useState<{
    key: string;
    override: string;
    terminal: "automatic" | "windows-terminal";
  } | null>(null);
  const values =
    draft?.key === draftKey
      ? draft
      : {
          override: capability.executableOverride ?? "",
          terminal: capability.terminalPreference ?? "automatic",
        };
  const { override, terminal } = values;
  const edit = (change: Partial<typeof values>) =>
    setDraft({ ...values, ...change, key: draftKey });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const neovimVisible =
    capability.state === "available" ||
    capability.state === "check-on-open" ||
    state.choice?.kind === "terminal";
  const preferred = state.choice?.editor ?? "";
  const save = async () => {
    const bridge = window.desktopBridge?.setTerminalEditorSettings;
    if (!connection || !bridge) return;
    setSaving(true);
    setError(null);
    try {
      await bridge({ connection, terminal, executableOverride: override || null });
      await state.terminal.refresh(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : gt("Could not save editor settings."));
    }
    setSaving(false);
  };
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold">
          <T>Editors</T>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <T>
            Choose how projects and files open on this client. Editor choices apply to the selected
            environment.
          </T>
        </p>
      </div>
      <label className="block space-y-2 text-sm">
        <T>Environment</T>
        <select
          aria-label={gt("Editor environment")}
          className="block w-full rounded-md border bg-background p-2"
          value={environmentId ?? ""}
          onChange={(event) => setSelectedEnvironment(event.target.value)}
        >
          {environments.map((environment) => (
            <option key={environment.environmentId} value={environment.environmentId}>
              {environment.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-2 text-sm">
        <T>Preferred editor</T>
        <select
          aria-label={gt("Preferred editor")}
          className="block w-full rounded-md border bg-background p-2"
          value={preferred}
          onChange={(event) => {
            const editor = EDITORS.find((editor) => editor.id === event.target.value);
            if (event.target.value === "neovim")
              state.select({ kind: "terminal", editor: "neovim" });
            else if (editor) state.select({ kind: "gui", editor: editor.id });
          }}
        >
          {!preferred && (
            <option value="" disabled>
              <T>No available editor</T>
            </option>
          )}
          {EDITORS.filter(
            (editor) => state.effectiveEditors.includes(editor.id) || editor.id === preferred,
          ).map((editor) => (
            <option key={editor.id} value={editor.id}>
              {editor.label}
            </option>
          ))}
          {neovimVisible && (
            <option value="neovim">
              <T>Neovim (Terminal)</T>
            </option>
          )}
        </select>
      </label>
      <Button variant="outline" size="sm" onClick={() => state.select(null)}>
        <T>Use default editor</T>
      </Button>
      <section className="space-y-4 border-t pt-5" aria-label={gt("Terminal editor settings")}>
        <div>
          <h2 className="font-medium">
            <T>Neovim (Terminal)</T>
          </h2>
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            {capability.message}
          </p>
          {capability.version && (
            <p className="mt-1 text-xs text-muted-foreground">
              {capability.version}
              {capability.account ? ` · ${capability.account}` : ""}
            </p>
          )}
        </div>
        {capability.reason === "ssh-association-required" && (
          <Link to="/settings/connections" className="text-sm underline">
            <T>Set up an SSH environment</T>
          </Link>
        )}
        <label className="block space-y-2 text-sm">
          <T>Terminal on this desktop</T>
          <select
            aria-label={gt("Terminal")}
            className="block w-full rounded-md border bg-background p-2"
            value={terminal}
            onChange={(event) =>
              edit({
                terminal:
                  event.target.value === "windows-terminal" ? "windows-terminal" : "automatic",
              })
            }
            disabled={!window.desktopBridge?.setTerminalEditorSettings}
          >
            <option value="automatic">
              <T>Automatic</T>
            </option>
            {terminal !== "automatic" &&
              !capability.terminals.some((item) => item.id === terminal) && (
                <option value={terminal}>
                  <T>Windows Terminal (unavailable)</T>
                </option>
              )}
            {capability.terminals.map((terminal) => (
              <option key={terminal.id} value={terminal.id}>
                {terminal.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-2 text-sm">
          <T>Neovim executable in this environment (optional)</T>
          <Input
            aria-label={gt("Neovim executable")}
            value={override}
            onChange={(event) => edit({ override: event.target.value })}
            placeholder={gt("Absolute path; leave empty to detect automatically")}
            disabled={!window.desktopBridge?.setTerminalEditorSettings}
          />
        </label>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={
              saving ||
              !state.terminal.connected ||
              !window.desktopBridge?.setTerminalEditorSettings
            }
          >
            <T>Save</T>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void state.terminal.rescan()}
            disabled={!state.terminal.connected || capability.state === "checking"}
          >
            <T>Rescan</T>
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
