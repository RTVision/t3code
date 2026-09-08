import { useMemo, useState } from "react";
import { DEFAULT_VIM_SETTINGS, type VimSettings } from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import { persistClientSettingsUpdate, useClientSettings } from "../hooks/useSettings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { formatShortcutLabel } from "../keybindings";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { bindingWarnings, resolveVimBindings, type VimBinding, type VimMode } from "./bindings";

export function VimSettingsPanel() {
  const settings = useClientSettings((value) => value.vim);
  const legacy = useAtomValue(primaryServerKeybindingsAtom);
  const [query, setQuery] = useState("");
  const bindings = useMemo(() => resolveVimBindings(settings), [settings]);
  const save = (update: (current: VimSettings) => VimSettings) => {
    void persistClientSettingsUpdate((current) => ({ ...current, vim: update(current.vim) })).catch(
      () => {
        toastManager.add({ type: "error", title: "Could not save Vim preferences" });
      },
    );
  };
  return (
    <section className="space-y-4 rounded-lg border p-4" aria-label="Vim navigation">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">Vim navigation</h2>
          <p className="text-xs text-muted-foreground">
            Saved on this client, across connected environments. Prompt editing stays unchanged.
          </p>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(enabled) => save((current) => ({ ...current, enabled }))}
          aria-label="Enable Vim navigation"
        />
      </div>
      <details>
        <summary className="cursor-pointer text-sm">Customize Vim shortcuts</summary>
        <div className="mt-3 space-y-3" data-keybinding-capture>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={settings.guideEnabled}
              onCheckedChange={(guideEnabled) => save((current) => ({ ...current, guideEnabled }))}
            />
            Show pending-key guide
          </label>
          {(["guideDelayMs", "sequenceTimeoutMs"] as const).map((key) => (
            <label key={key} className="flex items-center justify-between gap-2 text-xs">
              {key === "guideDelayMs"
                ? "Guide delay, milliseconds"
                : "Sequence timeout, milliseconds"}
              <input
                className="w-24 rounded border px-2 py-1"
                type="number"
                min={key === "guideDelayMs" ? 0 : 100}
                max={key === "guideDelayMs" ? 5000 : 10000}
                value={settings[key]}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (
                    Number.isInteger(value) &&
                    value >= (key === "guideDelayMs" ? 0 : 100) &&
                    value <= (key === "guideDelayMs" ? 5000 : 10000)
                  )
                    save((current) => ({ ...current, [key]: value }));
                }}
              />
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            Separate strokes with spaces, alternatives with commas. Use uppercase letters for Shift,
            such as G. Empty keys disable a command. Vim wins over ordinary shortcuts only in the
            selected modes.
          </p>
          <input
            aria-label="Filter Vim shortcuts"
            placeholder="Filter Vim shortcuts"
            className="w-full rounded border px-2 py-1 text-sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {bindings
            .filter((binding) =>
              `${binding.label} ${binding.command}`.toLowerCase().includes(query.toLowerCase()),
            )
            .map((binding) => (
              <BindingEditor
                key={
                  binding.command +
                  JSON.stringify(settings.bindings.find((item) => item.command === binding.command))
                }
                binding={binding}
                bindings={bindings}
                legacyLabels={legacy
                  .filter((entry) =>
                    binding.keys.some(
                      (key) =>
                        key.toLowerCase() ===
                        formatShortcutLabel(entry.shortcut, "Linux").toLowerCase(),
                    ),
                  )
                  .map((entry) => entry.command)}
                onSave={(keys, modes) =>
                  save((current) => ({
                    ...current,
                    bindings: [
                      ...current.bindings.filter((item) => item.command !== binding.command),
                      { command: binding.command, keys, modes },
                    ],
                  }))
                }
                onReset={() =>
                  save((current) => ({
                    ...current,
                    bindings: current.bindings.filter((item) => item.command !== binding.command),
                  }))
                }
              />
            ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              save((current) => ({ ...DEFAULT_VIM_SETTINGS, enabled: current.enabled }))
            }
          >
            Reset Vim defaults
          </Button>
        </div>
      </details>
    </section>
  );
}
function BindingEditor({
  binding,
  bindings,
  legacyLabels,
  onSave,
  onReset,
}: {
  binding: VimBinding;
  bindings: readonly VimBinding[];
  legacyLabels: string[];
  onSave: (keys: string[], modes: readonly VimMode[]) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState(binding.keys.join(", "));
  const [modes, setModes] = useState(binding.modes);
  const keys = draft
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const warnings = bindingWarnings({ ...binding, keys, modes }, bindings);
  return (
    <form
      className="space-y-1 border-t pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(keys, modes);
      }}
    >
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>{binding.label}</span>
        <input
          aria-label={binding.label}
          className="w-44 rounded border px-2 py-1 font-mono"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {(["normal", "insert", "terminal"] as const).map((mode) => (
          <label key={mode} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={modes.includes(mode)}
              onChange={(event) =>
                setModes(
                  event.target.checked ? [...modes, mode] : modes.filter((item) => item !== mode),
                )
              }
            />
            {mode}
          </label>
        ))}
        <Button
          type="submit"
          size="xs"
          disabled={warnings.some((warning) => warning.startsWith("Invalid"))}
        >
          Save
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onReset}>
          Reset
        </Button>
      </div>
      {warnings.map((warning) => (
        <p className="text-xs text-warning" key={warning}>
          {warning}
        </p>
      ))}
      {legacyLabels.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Overrides {legacyLabels.join(", ")} in the selected modes.
        </p>
      )}
    </form>
  );
}
