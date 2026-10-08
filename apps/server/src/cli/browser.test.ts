import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessEnvironment,
  HostProcessLinuxLibc,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { browserCommand } from "./browser.ts";

const windowsHost = HostProcessPlatform.defaultValue() === "win32";

it.layer(NodeServices.layer)("t3 browser setup", (it) => {
  for (const platform of ["linux", "win32"] as const) {
    for (const installed of [false, true]) {
      it.effect.skipIf(windowsHost && platform === "linux" && installed)(
        `honors the configured executable on ${platform}: ${installed}`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-setup-" });
            const executable = path.join(root, "custom-chromium");
            if (installed) {
              yield* fs.writeFileString(executable, "browser", {
                mode: platform === "win32" ? 0o644 : 0o755,
              });
            }
            const output = yield* Effect.gen(function* () {
              const previous = yield* TestConsole.logLines;
              yield* Command.runWith(browserCommand, { version: "0.0.0" })([
                "setup",
                "--base-dir",
                root,
              ]);
              return (yield* TestConsole.logLines).slice(previous.length);
            }).pipe(
              Effect.provide(TestConsole.layer),
              Effect.provideService(HostProcessPlatform, platform),
              Effect.provideService(HostProcessLinuxLibc, "gnu"),
              Effect.provideService(HostProcessEnvironment, {
                T3CODE_PREVIEW_BROWSER_PATH: executable,
              }),
            );

            expect(output).toHaveLength(1);
            expect(output[0]).toContain(
              installed ? `T3 uses ${executable}` : "T3CODE_PREVIEW_BROWSER_PATH points to",
            );
            expect(output[0]).not.toContain("runs as is");
            expect(yield* fs.exists(path.join(root, "tools"))).toBe(false);
          }),
      );
    }
  }

  for (const installed of [false, true]) {
    it.effect.skipIf(installed && windowsHost)(
      `reports native Chromium installation state: ${installed}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-setup-" });
          if (installed) {
            const executable = path.join(root, "usr/lib/chromium/chromium");
            yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
            yield* fs.writeFileString(executable, "#!/bin/sh\n", { mode: 0o755 });
          }

          const output = yield* Effect.gen(function* () {
            const previous = yield* TestConsole.logLines;
            yield* Command.runWith(browserCommand, { version: "0.0.0" })([
              "setup",
              "--base-dir",
              root,
            ]);
            return (yield* TestConsole.logLines).slice(previous.length);
          }).pipe(
            Effect.provide(TestConsole.layer),
            Effect.provideService(HostProcessPlatform, "linux"),
            Effect.provideService(HostProcessEnvironment, {}),
            Effect.provideService(HostProcessLinuxLibc, "musl"),
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              stat: (file) =>
                fs.stat(file.startsWith("/usr/") ? path.join(root, file.slice(1)) : file),
            }),
          );

          expect(output).toHaveLength(1);
          expect(output[0]).toContain(
            installed ? "T3 uses /usr/lib/chromium/chromium" : "apk add chromium",
          );
          expect(output[0]).not.toContain("installs on first use");
          expect(yield* fs.exists(path.join(root, "tools"))).toBe(false);
        }),
    );
  }
});
