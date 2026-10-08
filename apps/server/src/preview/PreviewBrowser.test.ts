import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessLinuxLibc,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
  type HostLinuxLibc,
} from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import type * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeZlib from "node:zlib";

import * as PreviewBrowser from "./PreviewBrowser.ts";

// POSIX modes cannot be checked on NTFS, so follow the host like the Antigravity suite.
const hostPlatform: NodeJS.Platform =
  HostProcessPlatform.defaultValue() === "win32" ? "win32" : "linux";
const executableName =
  hostPlatform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
const ROOT = "chrome-headless-shell-fixture/";

/** A stored ZIP whose entries carry Unix modes, like Chrome for Testing's archives. */
const makeZip = (
  entries: ReadonlyArray<{ readonly name: string; readonly data?: string; readonly mode: number }>,
) => {
  const records: Array<Buffer> = [];
  const directory: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    records.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, centralDirectory, end]);
};

const browserArchive = makeZip([
  { name: ROOT, mode: 0o40755 },
  { name: `${ROOT}${executableName}`, data: "#!/bin/sh\n", mode: 0o100755 },
  { name: `${ROOT}libEGL.so`, data: "library", mode: 0o100755 },
  { name: `${ROOT}locales/`, mode: 0o40755 },
  { name: `${ROOT}locales/en-US.pak`, data: "strings", mode: 0o100644 },
]);

const makeHarness = Effect.fn("test.makePreviewBrowser")(function* (
  options: {
    readonly archive?: Buffer;
    readonly sha256?: string;
    readonly body?: Stream.Stream<Uint8Array>;
    readonly wait?: Duration.Input;
    readonly unsupported?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly linuxLibc?: HostLinuxLibc;
    readonly executable?: string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preview-browser-test-" });
  const systemRoot = path.join(baseDir, "system");
  const archive = options.archive ?? browserArchive;
  const crypto = yield* Crypto.Crypto;
  const sha256 =
    options.sha256 ?? Hex.encode(yield* crypto.digest("SHA-256", archive).pipe(Effect.orDie));
  const requests: Array<string> = [];
  const browser = yield* PreviewBrowser.makePreviewBrowser({
    baseDir,
    release: options.unsupported
      ? null
      : {
          version: "1.2.3",
          platform: "fixture",
          url: "https://storage.googleapis.com/chrome-headless-shell-fixture.zip",
          bytes: archive.byteLength,
          sha256,
        },
    ...(options.wait === undefined ? {} : { wait: options.wait }),
  }).pipe(
    Effect.provideService(HostProcessPlatform, options.platform ?? hostPlatform),
    Effect.provideService(HostProcessArchitecture, "x64"),
    Effect.provideService(
      HostProcessEnvironment,
      options.executable === undefined ? {} : { T3CODE_PREVIEW_BROWSER_PATH: options.executable },
    ),
    Effect.provideService(HostProcessLinuxLibc, options.linuxLibc ?? "gnu"),
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      stat: (file) =>
        fs.stat(file.startsWith("/usr/") ? path.join(systemRoot, file.slice(1)) : file),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          const response = HttpClientResponse.fromWeb(request, new Response(null));
          return Object.defineProperty(response, "stream", {
            value: options.body ?? Stream.make(archive.subarray(0, 40), archive.subarray(40)),
          });
        }),
      ),
    ),
  );
  const installRoot = path.join(baseDir, "tools", "chrome-headless-shell", "fixture");
  return { browser, fs, path, baseDir, systemRoot, installRoot, requests };
});

it.layer(NodeServices.layer)("PreviewBrowser", (it) => {
  it.effect.skipIf(hostPlatform === "win32")(
    "uses native Chromium on musl Linux even with a downloaded browser present",
    () =>
      Effect.gen(function* () {
        const { browser, fs, path, systemRoot, installRoot, requests } = yield* makeHarness({
          platform: "linux",
          linuxLibc: "musl",
        });
        const native = path.join(systemRoot, "usr/lib/chromium/chromium");
        yield* fs.makeDirectory(path.dirname(native), { recursive: true });
        yield* fs.writeFileString(native, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.makeDirectory(path.join(installRoot, "1.2.3"), { recursive: true });
        const downloaded = path.join(installRoot, "1.2.3", executableName);
        yield* fs.writeFileString(downloaded, "old browser", { mode: 0o755 });

        expect(yield* browser.installed).toEqual(Option.some("/usr/lib/chromium/chromium"));
        expect(yield* browser.executable).toBe("/usr/lib/chromium/chromium");
        expect(requests).toEqual([]);
        expect(yield* fs.readFileString(downloaded)).toBe("old browser");
      }),
  );

  for (const platform of ["linux", "darwin", "win32", "freebsd"] as const) {
    it.effect.skipIf(hostPlatform === "win32" && platform !== "win32")(
      `uses the explicit executable before native or downloaded browsers on ${platform}`,
      () =>
        Effect.gen(function* () {
          const configured = "/usr/local/bin/custom-chromium";
          const { browser, fs, path, systemRoot, installRoot, requests } = yield* makeHarness({
            platform,
            linuxLibc: "musl",
            executable: configured,
            unsupported: platform === "freebsd",
          });
          const custom = path.join(systemRoot, configured.slice(1));
          yield* fs.makeDirectory(path.dirname(custom), { recursive: true });
          yield* fs.writeFileString(custom, "browser", {
            mode: platform === "win32" ? 0o644 : 0o755,
          });
          const native = path.join(systemRoot, "usr/lib/chromium/chromium");
          yield* fs.makeDirectory(path.dirname(native), { recursive: true });
          yield* fs.writeFileString(native, "native", { mode: 0o755 });
          const downloaded = path.join(installRoot, "1.2.3", executableName);
          yield* fs.makeDirectory(path.dirname(downloaded), { recursive: true });
          yield* fs.writeFileString(downloaded, "cached browser", { mode: 0o755 });

          expect(yield* browser.executable).toBe(configured);
          expect(yield* browser.installed).toEqual(Option.some(configured));
          expect(requests).toEqual([]);
          expect(yield* fs.readFileString(downloaded)).toBe("cached browser");
        }),
    );
  }

  it.effect("rejects an existing relative executable without native or download fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relative-browser-" });
      const executable = path.join(root, "chromium");
      yield* fs.writeFileString(executable, "browser", { mode: 0o755 });
      const configured = path.relative(yield* HostProcessWorkingDirectory, executable);
      const { browser, requests } = yield* makeHarness({
        executable: configured,
        linuxLibc: "musl",
      });

      expect(yield* browser.installed).toEqual(Option.none());
      const error = yield* browser.executable.pipe(Effect.flip);
      expect(error._tag).toBe("PreviewBrowserExecutableError");
      expect(error.message).toContain("absolute Chromium executable");
      expect(requests).toEqual([]);
    }),
  );

  for (const kind of ["missing", "directory", "non-executable", "empty"] as const) {
    it.effect.skipIf(hostPlatform === "win32" && kind === "non-executable")(
      `rejects a ${kind} override without native or download fallback`,
      () =>
        Effect.gen(function* () {
          const configured = kind === "empty" ? "" : "/usr/local/bin/custom-chromium";
          const { browser, fs, path, systemRoot, installRoot, requests } = yield* makeHarness({
            platform: hostPlatform,
            linuxLibc: kind === "missing" ? "gnu" : "musl",
            executable: configured,
          });
          const native = path.join(systemRoot, "usr/lib/chromium/chromium");
          yield* fs.makeDirectory(path.dirname(native), { recursive: true });
          yield* fs.writeFileString(native, "native", { mode: 0o755 });
          const downloaded = path.join(installRoot, "1.2.3", executableName);
          yield* fs.makeDirectory(path.dirname(downloaded), { recursive: true });
          yield* fs.writeFileString(downloaded, "cached browser", { mode: 0o755 });
          const custom = path.join(systemRoot, configured.slice(1));
          if (kind === "directory") yield* fs.makeDirectory(custom, { recursive: true });
          if (kind === "non-executable") {
            yield* fs.makeDirectory(path.dirname(custom), { recursive: true });
            yield* fs.writeFileString(custom, "browser", { mode: 0o644 });
          }

          expect(yield* browser.installed).toEqual(Option.none());
          const error = yield* browser.executable.pipe(Effect.flip);
          expect(error._tag).toBe("PreviewBrowserExecutableError");
          expect(error.message).toContain("T3CODE_PREVIEW_BROWSER_PATH");
          expect(requests).toEqual([]);
        }),
    );
  }

  it.effect.skipIf(hostPlatform === "win32")(
    "reports missing native Chromium and finds it after installation without a restart",
    () =>
      Effect.gen(function* () {
        const { browser, fs, path, systemRoot, requests } = yield* makeHarness({
          platform: "linux",
          linuxLibc: "musl",
        });
        expect(yield* browser.installed).toEqual(Option.none());
        const error = yield* browser.executable.pipe(Effect.flip);
        expect(error._tag).toBe("PreviewBrowserNativeMissingError");
        expect(error.message).toContain("apk add chromium");
        const native = path.join(systemRoot, "usr/bin/chromium");
        yield* fs.makeDirectory(path.dirname(native), { recursive: true });
        yield* fs.writeFileString(native, "#!/bin/sh\n", { mode: 0o755 });

        expect(yield* browser.executable).toBe("/usr/bin/chromium");
        expect(yield* browser.installed).toEqual(Option.some("/usr/bin/chromium"));
        expect(requests).toEqual([]);
      }),
  );

  it.effect.skipIf(hostPlatform === "win32")(
    "skips a non-executable native browser and uses the alternative launcher",
    () =>
      Effect.gen(function* () {
        const { browser, fs, path, systemRoot, requests } = yield* makeHarness({
          platform: "linux",
          linuxLibc: "musl",
        });
        const unusable = path.join(systemRoot, "usr/lib/chromium/chromium");
        const launcher = path.join(systemRoot, "usr/bin/chromium-browser");
        yield* fs.makeDirectory(path.dirname(unusable), { recursive: true });
        yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
        yield* fs.writeFileString(unusable, "not executable", { mode: 0o644 });
        yield* fs.writeFileString(launcher, "#!/bin/sh\n", { mode: 0o755 });

        expect(yield* browser.executable).toBe("/usr/bin/chromium-browser");
        expect(requests).toEqual([]);
      }),
  );

  it.effect("installs a verified download with its file modes and then reuses it", () =>
    Effect.gen(function* () {
      const { browser, fs, path, installRoot, requests } = yield* makeHarness();
      yield* fs.makeDirectory(path.join(installRoot, "1.0.0"), { recursive: true });
      // Another server's install in progress, and one abandoned two hours ago.
      const active = path.join(installRoot, ".install-other");
      const abandoned = path.join(installRoot, ".install-abandoned");
      yield* fs.makeDirectory(active);
      yield* fs.makeDirectory(abandoned);
      const twoHoursAgo = DateTime.toDate(DateTime.subtract(yield* DateTime.now, { hours: 2 }));
      yield* fs.utimes(abandoned, twoHoursAgo, twoHoursAgo);
      expect(yield* browser.installed).toEqual(Option.none());

      const executable = yield* browser.executable;

      const version = path.join(installRoot, "1.2.3");
      expect(executable).toBe(path.join(version, executableName));
      expect(yield* fs.readFileString(path.join(version, "locales", "en-US.pak"))).toBe("strings");
      if (hostPlatform !== "win32") {
        const mode = (file: string) =>
          fs.stat(path.join(version, file)).pipe(Effect.map((info) => info.mode & 0o777));
        expect(yield* mode(executableName)).toBe(0o755);
        expect(yield* mode("libEGL.so")).toBe(0o755);
        expect(yield* mode(path.join("locales", "en-US.pak"))).toBe(0o644);
      }
      // The old build and stale staging directories are gone; a fresh one stays.
      expect((yield* fs.readDirectory(installRoot)).toSorted()).toEqual([
        ".install-other",
        "1.2.3",
      ]);
      expect(yield* browser.executable).toBe(executable);
      expect(yield* browser.installed).toEqual(Option.some(executable));
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect.each([
    { name: "a hash mismatch", sha256: "0".repeat(64) },
    { name: "a short download", body: Stream.make(browserArchive.subarray(0, -1)) },
    {
      name: "an oversized download",
      body: Stream.make(browserArchive, Buffer.from("extra")),
    },
  ])("rejects $name, installs nothing, and retries on the next call", (testCase) =>
    Effect.gen(function* () {
      const { browser, fs, installRoot, requests } = yield* makeHarness(testCase);

      const error = yield* browser.executable.pipe(Effect.flip);

      expect(error._tag).toBe("PreviewBrowserInstallError");
      expect(error.message).toMatch(/^T3 could not install its headless browser: .+ Try again\.$/);
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
      yield* browser.executable.pipe(Effect.flip);
      expect(requests).toHaveLength(2);
    }),
  );

  it.effect.each([
    { name: "a parent-directory entry", entry: `${ROOT}../escape` },
    { name: "an absolute entry", entry: "/escape" },
    { name: "an entry outside the top directory", entry: "escape" },
  ])("rejects an archive with $name", (testCase) =>
    Effect.gen(function* () {
      const { browser, fs, path, baseDir, installRoot } = yield* makeHarness({
        archive: makeZip([
          { name: `${ROOT}${executableName}`, data: "#!/bin/sh\n", mode: 0o100755 },
          { name: testCase.entry, data: "escaped", mode: 0o100644 },
        ]),
      });

      const error = yield* browser.executable.pipe(Effect.flip);

      expect(error._tag).toBe("PreviewBrowserInstallError");
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
      expect(yield* fs.exists(path.join(baseDir, "tools", "chrome-headless-shell", "escape"))).toBe(
        false,
      );
    }),
  );

  it.effect("shares one install between callers and finishes it after they stop waiting", () =>
    Effect.gen(function* () {
      const firstChunkSent = yield* Deferred.make<void>();
      const finishDownload = yield* Deferred.make<void>();
      const { browser, requests } = yield* makeHarness({
        wait: "45 seconds",
        body: Stream.concat(
          Stream.make(browserArchive.subarray(0, 100)),
          Stream.fromEffect(
            Deferred.succeed(firstChunkSent, undefined).pipe(
              Effect.andThen(Deferred.await(finishDownload)),
              Effect.as(browserArchive.subarray(100)),
            ),
          ),
        ),
      });

      const callers = yield* Effect.forEach([1, 2], () =>
        Effect.forkChild(browser.executable.pipe(Effect.flip)),
      );
      yield* Deferred.await(firstChunkSent);
      yield* TestClock.adjust("45 seconds");
      for (const caller of callers) {
        expect(yield* Fiber.join(caller)).toMatchObject({
          _tag: "PreviewBrowserInstallingError",
          downloadedBytes: 100,
          unpacking: false,
        });
      }

      // The install belongs to the service, so it outlives the callers that gave up on it.
      yield* Deferred.succeed(finishDownload, undefined);
      expect(yield* browser.executable).toMatch(new RegExp(`${executableName}$`));
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect("reports hosts Chrome for Testing does not build for without downloading", () =>
    Effect.gen(function* () {
      const { browser, requests } = yield* makeHarness({ unsupported: true });
      expect((yield* browser.executable.pipe(Effect.flip))._tag).toBe(
        "PreviewBrowserUnsupportedError",
      );
      expect(yield* browser.installed).toEqual(Option.none());
      expect(requests).toEqual([]);
    }),
  );
});

it("pins one Chrome for Testing build per host", () => {
  const hosts = [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
    ["win32", "arm64"],
    ["win32", "ia32"],
    ["linux", "ia32"],
    ["freebsd", "x64"],
  ] as const;
  expect(
    hosts.map(([platform, arch]) => PreviewBrowser.previewBrowserRelease(platform, arch)?.platform),
  ).toEqual([
    "linux64",
    "linux-arm64",
    "mac-arm64",
    "mac-x64",
    "win64",
    "win64",
    "win32",
    undefined,
    undefined,
  ]);
  expect(PreviewBrowser.previewBrowserRelease("linux", "x64")).toMatchObject({
    url: "https://storage.googleapis.com/chrome-for-testing-public/154.0.8037.92/linux64/chrome-headless-shell-linux64.zip",
    bytes: 120_477_194,
  });
});

it("tells the agent how far the install has come", () => {
  expect(
    new PreviewBrowser.PreviewBrowserInstallingError({
      downloadedBytes: 37_200_000,
      totalBytes: 120_477_194,
      unpacking: false,
    }).message,
  ).toBe("T3 is installing its headless browser (37 of 120 MB downloaded). Try again in a minute.");
});
