import { type ServerConfig, ServerNpmReleaseError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Atom } from "effect/reactivity";

import { T3_NPM_PACKAGE, T3_NPM_REGISTRY } from "@t3tools/shared/releasePackage";
import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

const isServerNpmReleaseError = Schema.is(ServerNpmReleaseError);

/** Used by the release publication check, which must stay on RTVision's private registry. */
export const npmReleasePublished = Effect.fn("npmReleasePublished")((version: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(
      `${T3_NPM_REGISTRY}${T3_NPM_PACKAGE.replace("/", "%2F")}/${encodeURIComponent(version)}`,
    );
    if (response.status === 404) return false;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap((ok) => ok.json),
    );
    return (
      typeof body === "object" &&
      body !== null &&
      "version" in body &&
      typeof body.version === "string" &&
      body.version === version
    );
  }),
);

function unsupportedLookup(config: ServerConfig | null): ServerNpmReleaseError | null {
  if (config === null) {
    return new ServerNpmReleaseError({ reason: "Connect to this server to check releases." });
  }
  return config.environment.capabilities.npmReleaseLookup === true
    ? null
    : new ServerNpmReleaseError({
        reason: "This server does not support registry lookups. Update it before switching tracks.",
      });
}

export function npmReleaseFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return isServerNpmReleaseError(error)
    ? error.message
    : "Could not check this environment's npm registry. Check the connection and registry settings.";
}

export const npmReleaseAtom = Atom.family((spec: string) =>
  Atom.make((get) => {
    const primary = get(primaryEnvironmentIdAtom);
    // With the desktop's local server turned off there is no primary, so a connected server answers.
    const candidates =
      primary === null ? get(environmentSummaries.connectedEnvironmentIdsAtom) : [primary];
    const environmentId =
      candidates.find(
        (id) => unsupportedLookup(get(serverEnvironment.configValueAtom(id))) === null,
      ) ?? candidates[0];
    if (environmentId === undefined) {
      return Effect.fail(
        new ServerNpmReleaseError({ reason: "Connect to a server to check releases." }),
      );
    }
    const unsupported = unsupportedLookup(get(serverEnvironment.configValueAtom(environmentId)));
    if (unsupported !== null) return Effect.fail(unsupported);
    return get
      .result(serverEnvironment.npmRelease({ environmentId, input: { spec } }))
      .pipe(
        Effect.map((release) =>
          release === null
            ? null
            : { version: release.version, databaseMigration: release.databaseMigration },
        ),
      );
  }).pipe(Atom.withLabel(`npm-release:${spec}`)),
);
