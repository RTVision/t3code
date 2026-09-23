// @effect-diagnostics nodeBuiltinImport:off - Effect has no free-space query.
/**
 * DiskSpace - free space on the volume holding the T3 home.
 *
 * A full disk crashes the server at startup (routine state writes fail with
 * ENOSPC), and once it is down no client can say why. This service reports the
 * volume only while it is low, so clients can warn while there is still room
 * to act. Monitoring is advisory: a failed probe reports nothing rather than
 * propagating.
 *
 * @module DiskSpace
 */
import * as NodeFSP from "node:fs/promises";

import type { ServerLowDiskSpace } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "./config.ts";

const POLL_INTERVAL = Duration.minutes(1);

export function classifyDiskSpace(
  path: string,
  availableBytes: number,
  totalBytes: number,
): ServerLowDiskSpace | null {
  if (totalBytes <= 0) return null;
  const freeRatio = availableBytes / totalBytes;
  const level = freeRatio < 0.01 ? "critical" : freeRatio < 0.05 ? "warning" : null;
  return level === null ? null : { level, path, availableBytes, totalBytes };
}

/**
 * Reports differ on a level change or a move of at least 1% of the volume, so
 * a disk hovering under the threshold does not stream byte counts to clients.
 */
export function sameDiskSpaceReport(
  previous: ServerLowDiskSpace | null,
  next: ServerLowDiskSpace | null,
): boolean {
  if (previous === null || next === null) return previous === next;
  return (
    previous.level === next.level &&
    previous.path === next.path &&
    Math.abs(previous.availableBytes - next.availableBytes) < next.totalBytes / 100
  );
}

export class DiskSpace extends Context.Service<
  DiskSpace,
  {
    /** The low-space report right now, or null while space is fine. */
    readonly current: Effect.Effect<ServerLowDiskSpace | null>;
    /** The current report followed by every meaningful change. */
    readonly streamChanges: Stream.Stream<ServerLowDiskSpace | null>;
  }
>()("t3/diskSpace/DiskSpace") {}

const make = Effect.gen(function* () {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const report = yield* SubscriptionRef.make<ServerLowDiskSpace | null>(null);

  const check = Effect.tryPromise(() => NodeFSP.statfs(baseDir)).pipe(
    Effect.map((stats) =>
      classifyDiskSpace(baseDir, stats.bavail * stats.bsize, stats.blocks * stats.bsize),
    ),
    Effect.flatMap((next) =>
      Effect.flatMap(SubscriptionRef.get(report), (previous) =>
        sameDiskSpaceReport(previous, next) ? Effect.void : SubscriptionRef.set(report, next),
      ),
    ),
    Effect.ignoreCause({ log: true }),
  );

  yield* check;
  yield* check.pipe(Effect.delay(POLL_INTERVAL), Effect.forever, Effect.forkScoped);

  return {
    current: SubscriptionRef.get(report),
    streamChanges: SubscriptionRef.changes(report),
  } satisfies DiskSpace["Service"];
});

export const layer = Layer.effect(DiskSpace, make);
