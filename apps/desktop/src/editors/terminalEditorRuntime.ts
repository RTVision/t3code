// @effect-diagnostics nodeBuiltinImport:off - This adapter owns detached external terminal processes and private atomic preference files outside Effect subprocess scopes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";
import type {
  TerminalEditorCapability,
  TerminalEditorOpenRequest,
  TerminalEditorLaunchResult,
  TerminalEditorSettingsInput,
  TerminalEditorReason,
} from "@t3tools/contracts";
import {
  encodeRequest,
  findNeovim,
  run,
  windowsTerminalArgs,
  type TerminalRoute,
} from "../../scripts/neovim-terminal/transport.mjs";
import { probePosixRoute, type ProbeResult } from "./terminalProbe.ts";

export interface EditorRouteDescriptor {
  route: TerminalRoute;
  identity: string;
  generation: string;
}
export const routeHash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const Preferences = Schema.Struct({
  terminal: Schema.Literals(["automatic", "windows-terminal"]),
  overrides: Schema.Record(Schema.String, Schema.String),
});
const readPreferences = Schema.decodeUnknownSync(Preferences);

export function classifyProbeFailure(message: string): TerminalEditorReason {
  if (/T3NEOVIM_RUNTIME_MISSING/u.test(message)) return "missing-runtime";
  if (/timed out|timeout|ETIMEDOUT/iu.test(message)) return "timeout";
  if (
    /Permission denied|Host key verification failed|read_passphrase|sign_and_send_pubkey|no tty|authentication/iu.test(
      message,
    )
  )
    return "authentication-required";
  return "probe-error";
}

interface TerminalEditorOperations {
  discoverTerminal?: () => Promise<string | null>;
  probe?: (descriptor: EditorRouteDescriptor, override: string | null) => Promise<ProbeResult>;
  launch?: (terminal: string, args: readonly string[]) => Promise<void>;
}

export class TerminalEditorRuntime {
  private readonly operations: TerminalEditorOperations;
  private preferences: Promise<typeof Preferences.Type> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private terminal: Promise<string | null> | undefined;
  private probes = new Map<
    string,
    { expires: number; result: Promise<TerminalEditorCapability> }
  >();
  private launches = new Map<
    string,
    { fingerprint: string; result: Promise<TerminalEditorLaunchResult> }
  >();
  private readonly options: {
    platform: NodeJS.Platform;
    environment: NodeJS.ProcessEnv;
    stateDir: string;
    helperDir: string;
    runtime: string;
  };
  constructor(
    options: {
      platform: NodeJS.Platform;
      environment: NodeJS.ProcessEnv;
      stateDir: string;
      helperDir: string;
      runtime: string;
    },
    operations: TerminalEditorOperations = {},
  ) {
    this.options = options;
    this.operations = operations;
  }

  private settings() {
    this.preferences ??= NodeFSP.readFile(
      NodePath.join(this.options.stateDir, "terminal-editors.json"),
      "utf8",
    ).then(
      (text) => {
        try {
          return readPreferences(JSON.parse(text));
        } catch {
          return { terminal: "automatic" as const, overrides: {} };
        }
      },
      (error: NodeJS.ErrnoException) => {
        this.preferences = undefined;
        if (error.code !== "ENOENT") throw error;
        return { terminal: "automatic" as const, overrides: {} };
      },
    );
    return this.preferences;
  }
  async save(descriptor: EditorRouteDescriptor, input: TerminalEditorSettingsInput) {
    if (input.executableOverride !== null) {
      const paths =
        descriptor.route.kind === "native" && this.options.platform === "win32"
          ? NodePath.win32
          : NodePath.posix;
      if (!paths.isAbsolute(input.executableOverride))
        throw new Error("Enter an absolute executable path.");
    }
    const update = this.writes.then(async () => {
      const current = await this.settings();
      const overrides = { ...current.overrides };
      if (input.executableOverride === null) delete overrides[descriptor.identity];
      else overrides[descriptor.identity] = input.executableOverride;
      const next = { terminal: input.terminal, overrides };
      await NodeFSP.mkdir(this.options.stateDir, { recursive: true });
      const file = NodePath.join(this.options.stateDir, "terminal-editors.json");
      const temporary = `${file}.${NodeCrypto.randomUUID()}`;
      try {
        await NodeFSP.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
        await NodeFSP.rename(temporary, file);
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
      this.preferences = Promise.resolve(next);
      this.probes.clear();
      this.terminal = undefined;
    });
    this.writes = update.catch(() => {});
    return update;
  }

  private discoverTerminal() {
    this.terminal ??= (async () => {
      if (this.operations.discoverTerminal) return this.operations.discoverTerminal();
      if (this.options.platform !== "win32") return null;
      const environment = this.options.environment;
      const candidates = [
        NodePath.win32.join(environment.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "wt.exe"),
      ];
      for (const dir of (environment.PATH ?? "").split(";").filter(Boolean))
        candidates.push(NodePath.win32.join(dir, "wt.exe"));
      // Installed-app discovery covers disabled App Execution Aliases and desktop PATH differences.
      const powershell = this.powershell();
      try {
        const output = await run(
          powershell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-AppxPackage -Name Microsoft.WindowsTerminal | ForEach-Object { Join-Path $_.InstallLocation 'WindowsTerminal.exe' }",
          ],
          { input: "", timeout: 10_000, capture: true },
        );
        candidates.push(
          ...output
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean),
        );
      } catch {
        /* Alias and PATH candidates remain usable when AppX discovery is unavailable. */
      }
      for (const candidate of candidates) {
        if (!NodePath.win32.isAbsolute(candidate)) continue;
        try {
          await NodeFSP.access(candidate);
          return candidate;
        } catch {
          continue;
        }
      }
      return null;
    })();
    return this.terminal;
  }
  private powershell() {
    return NodePath.win32.join(
      this.options.environment.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  }

  async probe(
    descriptor: EditorRouteDescriptor,
    connectionGeneration: string,
    rescan = false,
  ): Promise<TerminalEditorCapability> {
    if (rescan) {
      this.probes.clear();
      this.terminal = undefined;
    }
    const settings = await this.settings();
    const override = settings.overrides[descriptor.identity] ?? null;
    const key = routeHash([
      descriptor.identity,
      descriptor.generation,
      connectionGeneration,
      override,
      settings.terminal,
    ]);
    const existing = this.probes.get(key);
    if (existing && existing.expires > performance.now()) return existing.result;
    const result = this.probeUncached(descriptor, key, override, settings.terminal);
    const entry = { expires: Infinity, result };
    this.probes.set(key, entry);
    if (this.probes.size > 64) this.probes.delete(this.probes.keys().next().value!);
    void result.then(
      (value) => {
        entry.expires = performance.now() + (value.state === "available" ? 60_000 : 5_000);
      },
      () => {
        if (this.probes.get(key) === entry) this.probes.delete(key);
      },
    );
    return result;
  }

  private async probeUncached(
    descriptor: EditorRouteDescriptor,
    generation: string,
    override: string | null,
    terminalPreference: "automatic" | "windows-terminal",
  ): Promise<TerminalEditorCapability> {
    const base = {
      routeGeneration: generation,
      preferenceKey: descriptor.identity,
      terminals: [] as { id: "windows-terminal"; label: string }[],
      selectedTerminal: null as "windows-terminal" | null,
      executableOverride: override,
      terminalPreference,
    };
    const unavailable = (
      reason: TerminalEditorReason,
      message: string,
    ): TerminalEditorCapability => ({ ...base, state: "unavailable", reason, message });
    if (this.options.platform !== "win32")
      return unavailable(
        "unsupported-platform",
        "Neovim (Terminal) currently requires the Windows desktop app. Linux terminal adapters are not available yet.",
      );
    if (!(await this.discoverTerminal()))
      return unavailable(
        "missing-terminal",
        "Install Windows Terminal, then Rescan in Settings → Editors.",
      );
    base.terminals = [{ id: "windows-terminal", label: "Windows Terminal" }];
    base.selectedTerminal = "windows-terminal";
    try {
      let probe: ProbeResult;
      if (this.operations.probe) probe = await this.operations.probe(descriptor, override);
      else if (descriptor.route.kind === "native") {
        let executable: string;
        try {
          executable = await findNeovim(override ?? undefined, this.options.environment);
        } catch (error) {
          if (error instanceof Error && error.message.includes("not found"))
            return unavailable(
              "missing-neovim",
              "Neovim was not found on this desktop. Install it or set its executable in Settings → Editors, then Rescan.",
            );
          throw error;
        }
        const version = await run(executable, ["--version"], {
          input: "",
          timeout: 10_000,
          capture: true,
        });
        probe = {
          executable,
          version: version.split(/\r?\n/u)[0] ?? "",
          account: NodeOS.userInfo().username,
          node: this.options.runtime,
        };
      } else {
        probe = await probePosixRoute(descriptor.route, override, this.options.platform);
        if (descriptor.route.kind === "wsl" && probe.account !== descriptor.route.user)
          return unavailable(
            "account-mismatch",
            "The WSL account changed. Reconnect the environment before opening Neovim.",
          );
      }
      if (probe.missing)
        return unavailable(
          "missing-neovim",
          "Neovim was not found in this environment's login PATH. Install it or set its executable in Settings → Editors, then Rescan.",
        );
      return {
        ...base,
        state: "available",
        message: "Opens Neovim in a new Windows Terminal window.",
        account: probe.account,
        ...(probe.executable ? { executable: probe.executable } : {}),
        ...(probe.version ? { version: probe.version } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = classifyProbeFailure(message);
      if (
        reason === "authentication-required" &&
        (descriptor.route.kind === "ssh" || descriptor.route.kind === "wsl-ssh")
      )
        return {
          ...base,
          state: "check-on-open",
          reason,
          message: "Check on open — SSH sign-in required. Authenticate in the new terminal window.",
        };
      return unavailable(
        reason,
        reason === "missing-runtime"
          ? "The selected account's login shell cannot find Node.js for the editor helper. Reconnect after fixing that account's Node.js PATH."
          : `Could not check Neovim: ${message.slice(0, 500)}`,
      );
    }
  }

  open(
    descriptor: EditorRouteDescriptor,
    input: TerminalEditorOpenRequest,
  ): Promise<TerminalEditorLaunchResult> {
    const fingerprint = routeHash(input);
    const existing = this.launches.get(input.requestId);
    if (existing)
      return existing.fingerprint === fingerprint
        ? existing.result
        : Promise.resolve({
            status: "failed",
            reason: "launch-failed",
            message: "This launch request ID was already used for a different target.",
          });
    if (this.launches.size >= 10_000)
      return Promise.resolve({
        status: "failed",
        reason: "launch-failed",
        message: "Restart the desktop app to open more terminal editor sessions.",
      });
    const result = this.openOnce(descriptor, input).catch(
      (error: unknown): TerminalEditorLaunchResult => ({
        status: "failed",
        reason: "launch-failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    this.launches.set(input.requestId, { fingerprint, result });
    return result;
  }
  private async openOnce(
    descriptor: EditorRouteDescriptor,
    input: TerminalEditorOpenRequest,
  ): Promise<TerminalEditorLaunchResult> {
    const capability = await this.probe(descriptor, input.connectionGeneration);
    if (capability.routeGeneration !== input.routeGeneration)
      return {
        status: "failed",
        reason: "stale-route",
        message: "The environment or editor settings changed. Rescan and open again.",
      };
    if (capability.state !== "available" && capability.state !== "check-on-open")
      return {
        status: "failed",
        reason: capability.reason ?? "route-unavailable",
        message: capability.message,
      };
    const terminal = await this.discoverTerminal();
    if (!terminal)
      return {
        status: "failed",
        reason: "missing-terminal",
        message: "Windows Terminal is no longer available. Rescan in Settings → Editors.",
      };
    const bootstrap = NodePath.join(this.options.helperDir, "launch.ps1");
    if (!this.operations.launch) await NodeFSP.access(bootstrap);
    const token = encodeRequest({
      version: 1,
      id: input.requestId,
      platform: this.options.platform,
      route: descriptor.route,
      workspace: input.workspacePath,
      target: input.target,
      ...((capability.executable ?? capability.executableOverride)
        ? { executable: (capability.executable ?? capability.executableOverride)! }
        : {}),
      ...(capability.account ? { expectedAccount: capability.account } : {}),
    });
    const args = windowsTerminalArgs({
      powershell: this.powershell(),
      bootstrap,
      runtime: this.options.runtime,
      token,
    });
    try {
      if (this.operations.launch) await this.operations.launch(terminal, args);
      else
        await new Promise<void>((resolve, reject) => {
          const child = NodeChildProcess.spawn(terminal, args, {
            detached: true,
            stdio: "ignore",
            shell: false,
          });
          child.once("error", reject);
          child.once("spawn", resolve);
          child.unref();
        });
    } catch (error) {
      this.probes.clear();
      this.terminal = undefined;
      throw error;
    }
    return { status: "accepted" };
  }
}
