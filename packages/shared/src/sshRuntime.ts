/**
 * Shared by the packaged SSH helper and the generated Node snippet. Keep this
 * self-contained: the SSH script embeds the function with toString().
 */
export function resolveSshRuntimePort(runtime: {
  readonly pid?: unknown;
  readonly launcherPid?: unknown;
  readonly port?: unknown;
  readonly origin?: unknown;
}): string | undefined {
  try {
    const pid = Number(runtime.pid);
    const ownerPid = runtime.launcherPid === undefined ? pid : Number(runtime.launcherPid);
    const port = Number(runtime.port);
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !Number.isInteger(ownerPid) ||
      ownerPid <= 0 ||
      !Number.isInteger(port)
    ) {
      return undefined;
    }
    const origin = new URL(String(runtime.origin ?? ""));
    if (
      origin.protocol !== "http:" ||
      (runtime.launcherPid === undefined && !["127.0.0.1", "localhost"].includes(origin.hostname))
    ) {
      return undefined;
    }
    // The launcher owns the port while its server child is being replaced.
    process.kill(ownerPid, 0);
    return `${pid} ${port}`;
  } catch {
    return undefined;
  }
}
