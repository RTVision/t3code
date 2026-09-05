import { useAtomValue } from "@effect/atom-react";
import { EDITORS } from "@t3tools/contracts";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useEditorChoice } from "../../editorPreferences";
import { invalidateTerminalEditors } from "../../terminalEditors";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function EditorsSettingsPanel() {
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [selectedEnvironment, setSelectedEnvironment] = useState<string | null>(null);
  const environmentId =
    environments.find((environment) => environment.environmentId === selectedEnvironment)
      ?.environmentId ?? primary;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const state = useEditorChoice(environmentId, config?.availableEditors ?? []);
  const { capability, connection } = state.terminal;
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
      invalidateTerminalEditors();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save editor settings.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold">Editors</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how projects and files open on this client. Editor choices apply to the selected
          environment.
        </p>
      </div>
      <label className="block space-y-2 text-sm">
        Environment
        <select
          aria-label="Editor environment"
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
        Preferred editor
        <select
          aria-label="Preferred editor"
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
              No available editor
            </option>
          )}
          {EDITORS.filter(
            (editor) => state.effectiveEditors.includes(editor.id) || editor.id === preferred,
          ).map((editor) => (
            <option key={editor.id} value={editor.id}>
              {editor.label}
            </option>
          ))}
          {neovimVisible && <option value="neovim">Neovim (Terminal)</option>}
        </select>
      </label>
      <Button variant="outline" size="sm" onClick={() => state.select(null)}>
        Use default editor
      </Button>
      <section className="space-y-4 border-t pt-5" aria-label="Terminal editor settings">
        <div>
          <h2 className="font-medium">Neovim (Terminal)</h2>
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
            Set up an SSH environment
          </Link>
        )}
        <label className="block space-y-2 text-sm">
          Terminal on this desktop
          <select
            aria-label="Terminal"
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
            <option value="automatic">Automatic</option>
            {terminal !== "automatic" &&
              !capability.terminals.some((item) => item.id === terminal) && (
                <option value={terminal}>Windows Terminal (unavailable)</option>
              )}
            {capability.terminals.map((terminal) => (
              <option key={terminal.id} value={terminal.id}>
                {terminal.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-2 text-sm">
          Neovim executable in this environment (optional)
          <Input
            aria-label="Neovim executable"
            value={override}
            onChange={(event) => edit({ override: event.target.value })}
            placeholder="Absolute path; leave empty to detect automatically"
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
            Save
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void state.terminal.rescan()}
            disabled={!state.terminal.connected || capability.state === "checking"}
          >
            Rescan
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
