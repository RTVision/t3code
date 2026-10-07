import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";

const TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

function harness(
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }> = {},
  signedOut: ReadonlyArray<string> = [],
  tokens: Record<string, string> = {},
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const process = Layer.mock(VcsProcess.VcsProcess)({
    run: (input) =>
      Effect.sync(() => {
        calls.push(input.args);
        const user = input.args[input.args.indexOf("--user") + 1];
        if (input.args.includes("--user") && user !== undefined && signedOut.includes(user)) {
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: input.args.includes("--user") ? `token-for-${user}\n` : "active-token\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  const layer = GitHubCredentials.layer.pipe(
    Layer.provideMerge(
      ServerSettings.ServerSettingsService.layerTest({ github: { hosts, tokens } }),
    ),
    Layer.provide(process),
    Layer.provide(NodeServices.layer),
  );
  return { layer, calls };
}

describe("GitHubCredentials", () => {
  beforeEach(() => {
    for (const name of TOKEN_VARIABLES) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect.each(TOKEN_VARIABLES)(
    "keeps ambient %s out of the stored-credential subprocess for another host",
    (name) =>
      Effect.gen(function* () {
        vi.stubEnv(name, "dummy-ambient-token");
        vi.stubEnv("GH_HOST", "trusted.example");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gh-credentials-" });
        const script = path.join(directory, "gh.cjs");
        yield* fs.writeFileString(
          path.join(directory, "tokens.json"),
          JSON.stringify({ "github.unrelated.example": { work: "stored-work-token" } }),
        );
        yield* fs.writeFileString(
          script,
          `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const host = args[args.indexOf("--hostname") + 1];
const account = args[args.indexOf("--user") + 1];
const ambient = ${JSON.stringify(TOKEN_VARIABLES)}.map(name => process.env[name]).find(Boolean);
const stored = JSON.parse(fs.readFileSync(path.join(process.env.GH_CONFIG_DIR, "tokens.json"), "utf8"));
process.stdout.write(ambient || stored[host]?.[account] || "");
`,
        );
        vi.stubEnv("GH_CONFIG_DIR", directory);
        // Use the real process layers; only replace the external gh executable with a fixture.
        const vcs = yield* VcsProcess.make;
        const credentialLayer = GitHubCredentials.layer.pipe(
          Layer.provide(
            ServerSettings.ServerSettingsService.layerTest({
              github: { hosts: { "github.unrelated.example": { account: "work" } } },
            }),
          ),
          Layer.provide(
            Layer.succeed(
              VcsProcess.VcsProcess,
              VcsProcess.VcsProcess.of({
                run: (input) =>
                  vcs.run({ ...input, command: process.execPath, args: [script, ...input.args] }),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const credentials = yield* GitHubCredentials.GitHubCredentials;
          const credential = yield* credentials.get("github.unrelated.example");
          expect(credential.source).toBe("gh");
          expect(Redacted.value(credential.token)).toBe("stored-work-token");
          const missing = yield* Effect.flip(credentials.get("github.no-login.example"));
          expect(missing._tag).toBe("GitHubNotSignedInError");
          expect(missing.host).toBe("github.no-login.example");
        }).pipe(Effect.provide(credentialLayer));
      }).pipe(
        Effect.scoped,
        Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
  );

  it.effect.each(["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"])(
    "keeps allowed %s as a direct credential for its intended host",
    (name) => {
      vi.stubEnv(name, "allowed-enterprise-token");
      vi.stubEnv("GH_HOST", "trusted.example");
      const { layer, calls } = harness({ "trusted.example": { account: "work" } });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        const credential = yield* credentials.get("trusted.example");
        expect(credential.source).toBe("env");
        expect(Redacted.value(credential.token)).toBe("allowed-enterprise-token");
        expect(calls).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("asks gh for the active login when Settings pin nothing", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("GitHub.com");
      expect(Redacted.value(credential.token)).toBe("active-token");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes --user for an account pinned in Settings", () => {
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("token-for-work");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "work"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a host turned off in Settings without asking gh", () => {
    const { layer, calls } = harness({ "github.com": { enabled: false } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("github.com"));
      expect(error._tag).toBe("GitHubHostDisabledError");
      expect(error.message).toBe(
        "GitHub host github.com is turned off in Settings → Source Control.",
      );
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an environment token win over a pinned account, as gh does", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("from-env");
      expect(credential.source).toBe("env");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks up a changed account on the next request without a restart", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const settings = yield* ServerSettings.ServerSettingsService;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");

      yield* settings.updateSettings({
        github: { hosts: { "github.com": { account: "work", enabled: true } } },
      });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("token-for-work");

      yield* settings.updateSettings({ github: { hosts: { "github.com": { enabled: false } } } });
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );

      yield* settings.updateSettings({ github: { hosts: {} } });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      // The unpinned token stayed cached; only the newly pinned account cost a gh call.
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the active login when the pinned one is no longer signed in", () => {
    const { layer, calls } = harness({ "github.com": { account: "gone" } }, ["gone"]);
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "gone"],
        ["auth", "token", "--hostname", "github.com"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses a token saved in Settings before GH_TOKEN and gh", () => {
    vi.stubEnv("GH_TOKEN", "env-token");
    const { layer, calls } = harness({}, [], { "github.com": "saved-token" });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("saved-token");
      expect(credential.source).toBe("settings");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a host turned off even with a token saved in Settings", () => {
    const { layer } = harness({ "github.com": { enabled: false } }, [], {
      "github.com": "saved-token",
    });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );
    }).pipe(Effect.provide(layer));
  });
});
