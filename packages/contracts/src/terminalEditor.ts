import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";
import { EditorId } from "./editor.ts";

const Path = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16_384),
  Schema.isPattern(/^[^\0]+$/u),
);
const Position = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }));
export const EditorChoice = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("gui"), editor: EditorId }),
  Schema.Struct({ kind: Schema.Literal("terminal"), editor: Schema.Literal("neovim") }),
]);
export type EditorChoice = typeof EditorChoice.Type;
export const EditorOpenTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("directory"), path: Path }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Path,
    line: Schema.optionalKey(Position),
    column: Schema.optionalKey(Position),
    columnEncoding: Schema.optionalKey(Schema.Literals(["utf-8", "utf-16"])),
  }),
]);
export type EditorOpenTarget = typeof EditorOpenTarget.Type;
export const DesktopEditorConnectionRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("primary") }),
  Schema.Struct({ kind: Schema.Literal("local"), backendId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("saved"), environmentId: EnvironmentId }),
]);
export type DesktopEditorConnectionRef = typeof DesktopEditorConnectionRef.Type;
export const TerminalEditorReason = Schema.Literals([
  "desktop-required",
  "unsupported-platform",
  "missing-terminal",
  "missing-neovim",
  "missing-runtime",
  "ssh-association-required",
  "route-unavailable",
  "runner-mismatch",
  "account-mismatch",
  "disconnected",
  "timeout",
  "authentication-required",
  "probe-error",
  "stale-route",
  "launch-failed",
]);
export type TerminalEditorReason = typeof TerminalEditorReason.Type;
export const TerminalEditorProbeInput = Schema.Struct({
  connection: DesktopEditorConnectionRef,
  // Changes when the viewing client's connection restarts; stale results are discarded client-side too.
  connectionGeneration: Schema.String,
  rescan: Schema.optionalKey(Schema.Boolean),
});
export type TerminalEditorProbeInput = typeof TerminalEditorProbeInput.Type;
export const TerminalEditorCapability = Schema.Struct({
  state: Schema.Literals(["checking", "available", "check-on-open", "unavailable"]),
  reason: Schema.optionalKey(TerminalEditorReason),
  message: Schema.String,
  routeGeneration: Schema.String,
  preferenceKey: Schema.String,
  terminals: Schema.Array(
    Schema.Struct({ id: Schema.Literal("windows-terminal"), label: Schema.String }),
  ),
  terminalPreference: Schema.optionalKey(Schema.Literals(["automatic", "windows-terminal"])),
  selectedTerminal: Schema.NullOr(Schema.Literal("windows-terminal")),
  executableOverride: Schema.NullOr(Schema.String),
  account: Schema.optionalKey(Schema.String),
  executable: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
});
export type TerminalEditorCapability = typeof TerminalEditorCapability.Type;
export const TerminalEditorSettingsInput = Schema.Struct({
  connection: DesktopEditorConnectionRef,
  terminal: Schema.Literals(["automatic", "windows-terminal"]),
  executableOverride: Schema.NullOr(Path),
});
export type TerminalEditorSettingsInput = typeof TerminalEditorSettingsInput.Type;
export const TerminalEditorOpenRequest = Schema.Struct({
  ...TerminalEditorProbeInput.fields,
  requestId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
  routeGeneration: Schema.String,
  editor: Schema.Literal("neovim"),
  workspacePath: Path,
  target: EditorOpenTarget,
});
export type TerminalEditorOpenRequest = typeof TerminalEditorOpenRequest.Type;
export const TerminalEditorLaunchResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("accepted") }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: TerminalEditorReason,
    message: Schema.String,
  }),
]);
export type TerminalEditorLaunchResult = typeof TerminalEditorLaunchResult.Type;
