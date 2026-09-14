import { afterEach, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/unstable/http";

import { fixPath } from "../os-jank.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ForgejoCli from "./ForgejoCli.ts";

afterEach(() => vi.unstubAllEnvs());

const layer = Layer.mergeAll(
  VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  FetchHttpClient.layer,
);

const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tea-config-" });
  const binaries = path.join(root, "bin");
  const wrappers = path.join(root, "wrappers");
  const managed = path.join(root, "managed");
  const personal = path.join(root, "personal");
  for (const directory of [binaries, wrappers, managed, personal]) {
    yield* fs.makeDirectory(directory);
  }
  for (const [directory, contents] of [
    [managed, "managed-login"],
    [personal, "personal-login"],
  ] as const) {
    yield* fs.writeFileString(path.join(directory, "login"), contents);
  }
  for (const command of ["tea", "fj"]) {
    const executable = path.join(binaries, command);
    yield* fs.writeFileString(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
process.stdout.write(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, "login")));
`,
    );
    yield* fs.chmod(executable, 0o755);
  }
  const wrapper = path.join(wrappers, "tea");
  yield* fs.writeFileString(wrapper, "#!/bin/sh\nexit 99\n");
  yield* fs.chmod(wrapper, 0o755);
  const shell = path.join(root, "login-shell");
  yield* fs.writeFileString(
    shell,
    `#!/bin/sh
printf '%s\\n' '__T3CODE_ENV_PATH_START__' '${binaries}' '__T3CODE_ENV_PATH_END__'
`,
  );
  yield* fs.chmod(shell, 0o755);
  vi.stubEnv("SHELL", shell);
  vi.stubEnv("PATH", `${wrappers}:${process.env.PATH ?? ""}`);
  vi.stubEnv("XDG_CONFIG_HOME", personal);
  vi.stubEnv("T3CODE_TEA_CONFIG_HOME", managed);
  yield* fixPath();
  expect(process.env.PATH?.split(":")[0]).toBe(binaries);
  return { root, personal };
});

it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "keeps the managed tea login after startup bypasses the PATH wrapper",
  () =>
    Effect.gen(function* () {
      const { root, personal } = yield* fixture();
      const cli = yield* ForgejoCli.make;
      for (const command of [undefined, "tea", "fj"] as const) {
        const result = yield* cli.execute({
          ...(command ? { command } : {}),
          cwd: root,
          args: [],
        });
        expect(result.stdout).toBe(command === "fj" ? "personal-login" : "managed-login");
      }
      expect(process.env.XDG_CONFIG_HOME).toBe(personal);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "uses the normal tea configuration when no managed config is selected",
  () =>
    Effect.gen(function* () {
      const { root } = yield* fixture();
      for (const configHome of [undefined, "", "   "]) {
        vi.stubEnv("T3CODE_TEA_CONFIG_HOME", configHome);
        const cli = yield* ForgejoCli.make;
        expect((yield* cli.execute({ cwd: root, args: [] })).stdout).toBe("personal-login");
      }
    }).pipe(Effect.provide(layer), Effect.scoped),
);
