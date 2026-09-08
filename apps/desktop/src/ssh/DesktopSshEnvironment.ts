import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SshRunner } from "@t3tools/ssh/runner";
import { matchesSshRunner, sshRunnerIdentity } from "./DesktopSshRunner.ts";

import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import { resolveSshTarget } from "@t3tools/ssh/command";
import { discoverSshHosts } from "@t3tools/ssh/config";
import {
  SshCommandError,
  SshHostDiscoveryError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

export type DesktopSshEnvironmentRuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

export type DesktopSshEnvironmentOperationError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

export type DesktopSshEnvironmentDiscoverError = SshHostDiscoveryError | SshCommandError;

export type DesktopSshEnvironmentError =
  | DesktopSshEnvironmentDiscoverError
  | DesktopSshEnvironmentOperationError;

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  {
    readonly discoverHosts: (input?: {
      readonly homeDir?: string;
    }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
    readonly resolveHost: (
      alias: string,
    ) => Effect.Effect<DesktopSshEnvironmentTarget, SshCommandError | SshInvalidTargetError>;
    readonly ensureEnvironment: (
      target: DesktopSshEnvironmentTarget,
      options?: { readonly issuePairingToken?: boolean; readonly isNewTarget?: boolean },
    ) => Effect.Effect<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
    readonly disconnectEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
  }
>()("@t3tools/desktop/ssh/DesktopSshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: Effect.Effect<SshTunnel.RemoteT3RunnerOptions>;
  readonly resolveSshRunner?: Effect.Effect<SshRunner, SshCommandError>;
}

function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return discoverSshHosts(input ?? {});
}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    error instanceof SshPasswordPromptError &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

function unexpectedPasswordPromptError(error: never): never {
  throw new Error(`Unhandled desktop SSH password prompt error: ${String(error)}`);
}

export function toSshPasswordPromptError(
  cause: DesktopSshPasswordPrompts.DesktopSshPasswordPromptRequestError,
): SshPasswordPromptError {
  let message: string;
  switch (cause._tag) {
    case "DesktopSshPromptRequestIdGenerationError":
      message = "Secure randomness is unavailable.";
      break;
    case "DesktopSshPromptWindowUnavailableError":
    case "DesktopSshPromptPresentationError":
      message = "T3 Code window is not available for SSH authentication.";
      break;
    case "DesktopSshPromptTimedOutError":
      message = `SSH authentication timed out for ${cause.destination}.`;
      break;
    case "DesktopSshPromptCancelledError":
      message = `SSH authentication cancelled for ${cause.destination}.`;
      break;
    case "DesktopSshPromptWindowClosedError":
      message = "SSH authentication was cancelled because the app window closed.";
      break;
    case "DesktopSshPromptServiceStoppedError":
      message = "SSH password prompt service stopped.";
      break;
    default:
      return unexpectedPasswordPromptError(cause);
  }
  return new SshPasswordPromptError({ message, cause });
}

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPrompts["Service"],
): SshAuth.SshPasswordPrompt["Service"] => ({
  isAvailable: true,
  request: (request: SshAuth.SshPasswordRequest) =>
    prompts.request(request).pipe(Effect.mapError(toSshPasswordPromptError)),
});

export function prepareTargetForSshRunner(
  target: DesktopSshEnvironmentTarget,
  runner: SshRunner,
  platform: NodeJS.Platform,
  isNewTarget: boolean,
): Effect.Effect<DesktopSshEnvironmentTarget, SshCommandError> {
  const identity = sshRunnerIdentity(runner, platform);
  if ((target.runner !== undefined || !isNewTarget) && !matchesSshRunner(target.runner, identity)) {
    return Effect.fail(
      new SshCommandError({
        command: ["ssh"],
        exitCode: null,
        stderr: "",
        message:
          "This saved SSH environment uses a different SSH runner, WSL distro or account. Restore its runner in Settings → Connections, or remove and add the environment again.",
      }),
    );
  }
  return Effect.succeed({ ...target, ...(identity === undefined ? {} : { runner: identity }) });
}

export const make = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Effect.gen(function* () {
    const manager = yield* SshTunnel.SshEnvironmentManager;
    const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
    const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
    const passwordPrompt = SshAuth.SshPasswordPrompt.of(makePasswordPrompt(prompts));
    const platform = yield* HostProcessPlatform;
    const resolveRunner = options.resolveSshRunner ?? Effect.succeed({ kind: "native" } as const);
    const withRunner = Effect.fn("desktop.ssh.withRunner")(function* <A, E, R>(
      operation: (runner: SshRunner) => Effect.Effect<A, E, R>,
    ) {
      const runner = yield* resolveRunner;
      return yield* operation(runner).pipe(Effect.provideService(SshRunner, runner));
    });
    return DesktopSshEnvironment.of({
      discoverHosts: (input) =>
        withRunner(() => discoverDesktopSshHostsEffect(input)).pipe(
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.discoverHosts"),
        ),
      resolveHost: (alias) =>
        withRunner((runner) =>
          resolveSshTarget(alias.trim()).pipe(
            Effect.map((target) => {
              const identity = sshRunnerIdentity(runner, platform);
              return { ...target, ...(identity === undefined ? {} : { runner: identity }) };
            }),
          ),
        ).pipe(Effect.provide(runtimeContext), Effect.withSpan("desktop.ssh.resolveHost")),
      ensureEnvironment: (target, ensureOptions) =>
        withRunner((runner) =>
          prepareTargetForSshRunner(
            target,
            runner,
            platform,
            ensureOptions?.isNewTarget === true,
          ).pipe(Effect.flatMap((resolved) => manager.ensureEnvironment(resolved, ensureOptions))),
        ).pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.ensureEnvironment"),
        ),
      disconnectEnvironment: (target) =>
        withRunner((runner) =>
          prepareTargetForSshRunner(target, runner, platform, false).pipe(
            Effect.flatMap((resolved) => manager.disconnectEnvironment(resolved)),
          ),
        ).pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.disconnectEnvironment"),
        ),
    });
  });

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make(options)).pipe(
    Layer.provide(
      SshTunnel.SshEnvironmentManager.layer({
        ...(options.resolveCliPackageSpec === undefined
          ? {}
          : { resolveCliPackageSpec: options.resolveCliPackageSpec }),
        ...(options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner }),
      }),
    ),
  );
