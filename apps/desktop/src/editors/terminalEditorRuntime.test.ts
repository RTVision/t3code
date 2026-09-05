// @effect-diagnostics nodeBuiltinImport:off - Private filesystem fixtures exercise persistence at the external launcher boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { TerminalEditorOpenRequest } from "@t3tools/contracts";
import { TerminalEditorRuntime, type EditorRouteDescriptor } from "./terminalEditorRuntime.ts";
import { parseNeovimProbe, neovimProbeScript } from "./terminalProbe.ts";
import { run } from "../../scripts/neovim-terminal/transport.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});
const descriptor: EditorRouteDescriptor = {
  route: { kind: "wsl", distro: "Ubuntu", user: "alice" },
  identity: "primary-alice",
  generation: "pid-1",
};
const ready = {
  account: "alice",
  executable: "/usr/bin/nvim",
  version: "NVIM v0.11.0",
  node: "/usr/bin/node",
};
async function harness(probe = vi.fn(async () => ready)) {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-terminal-editor-"));
  directories.push(stateDir);
  const launch = vi.fn(async () => {});
  const runtime = new TerminalEditorRuntime(
    {
      platform: "win32",
      environment: {},
      stateDir,
      runtime: "C:\\T3\\T3.exe",
      helperDir: "C:\\T3\\resources\\neovim-terminal",
    },
    { probe, discoverTerminal: async () => "C:\\WindowsApps\\wt.exe", launch },
  );
  return { runtime, launch, probe, stateDir };
}
function request(routeGeneration: string): TerminalEditorOpenRequest {
  return {
    requestId: "19541794-037e-4ac1-bccb-ed6fc9f2bcaa",
    connection: { kind: "primary" },
    connectionGeneration: "1",
    routeGeneration,
    editor: "neovim",
    workspacePath: "/worktree",
    target: { kind: "file", path: "/other/file.txt", line: 4, column: 3 },
  };
}

it("opens one window for duplicate delivery and rejects request ID reuse for another target", async () => {
  const { runtime, launch } = await harness();
  const capability = await runtime.probe(descriptor, "1");
  const input = request(capability.routeGeneration);
  const results = await Promise.all([
    runtime.open(descriptor, input),
    runtime.open(descriptor, input),
  ]);
  expect(results).toEqual([{ status: "accepted" }, { status: "accepted" }]);
  expect(launch).toHaveBeenCalledTimes(1);
  expect((await runtime.open(descriptor, { ...input, workspacePath: "/different" })).status).toBe(
    "failed",
  );
  expect(launch).toHaveBeenCalledTimes(1);
});
it("does not replay an accepted launch after a reconnect", async () => {
  const { runtime, launch } = await harness();
  const capability = await runtime.probe(descriptor, "1");
  const input = request(capability.routeGeneration);
  await runtime.open(descriptor, input);
  await runtime.open({ ...descriptor, generation: "new-pid" }, input);
  expect(launch).toHaveBeenCalledTimes(1);
});
it("rejects a stale probe after backend replacement before spawning a window", async () => {
  const { runtime, launch } = await harness();
  const capability = await runtime.probe(descriptor, "1");
  const result = await runtime.open(
    { ...descriptor, generation: "pid-2" },
    request(capability.routeGeneration),
  );
  expect(result).toMatchObject({ status: "failed", reason: "stale-route" });
  expect(launch).not.toHaveBeenCalled();
});
it("keeps SSH authentication distinct from a timeout and recovers on rescan", async () => {
  const probe = vi
    .fn(async () => ready)
    .mockRejectedValueOnce(new Error("Permission denied (publickey)."));
  const { runtime } = await harness(probe);
  const ssh: EditorRouteDescriptor = { ...descriptor, route: { kind: "ssh", host: "work-alias" } };
  expect(await runtime.probe(ssh, "1")).toMatchObject({
    state: "check-on-open",
    reason: "authentication-required",
  });
  expect(await runtime.probe(ssh, "1")).toMatchObject({ state: "check-on-open" });
  expect(probe).toHaveBeenCalledTimes(1);
  probe.mockRejectedValueOnce(new Error("ssh timed out."));
  expect(await runtime.probe(ssh, "1", true)).toMatchObject({
    state: "unavailable",
    reason: "timeout",
  });
  expect(await runtime.probe(ssh, "1", true)).toMatchObject({ state: "available" });
});
it("scopes executable overrides by route and invalidates old launch generations", async () => {
  const { runtime } = await harness();
  const previous = await runtime.probe(descriptor, "1");
  await runtime.save(descriptor, {
    connection: { kind: "primary" },
    terminal: "windows-terminal",
    executableOverride: "/home/alice/nvim",
  });
  expect(await runtime.probe(descriptor, "1")).toMatchObject({
    executableOverride: "/home/alice/nvim",
  });
  expect(await runtime.probe({ ...descriptor, identity: "primary-bob" }, "1")).toMatchObject({
    executableOverride: null,
  });
  expect(await runtime.open(descriptor, request(previous.routeGeneration))).toMatchObject({
    status: "failed",
    reason: "stale-route",
  });
  await runtime.save(descriptor, {
    connection: { kind: "primary" },
    terminal: "automatic",
    executableOverride: null,
  });
  expect(await runtime.probe(descriptor, "1")).toMatchObject({ executableOverride: null });
});
it("reads framed discovery despite banners and distinguishes a missing binary", async () => {
  const result = await run("/bin/bash", ["-l", "-s"], {
    input: neovimProbeScript("/t3-neovim-does-not-exist"),
    timeout: 15_000,
    capture: true,
  });
  expect(parseNeovimProbe(`login banner\n${result}\nlogout banner`)).toMatchObject({
    missing: true,
  });
  expect(() => parseNeovimProbe("only a startup banner")).toThrow(/login script/u);
});
