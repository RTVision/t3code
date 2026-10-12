import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { T3_NPM_PACKAGE, T3_NPM_REGISTRY } from "@t3tools/shared/releasePackage";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

export const npmReleasePublished = (version: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(
      `${T3_NPM_REGISTRY}${T3_NPM_PACKAGE.replace("/", "%2F")}/${encodeURIComponent(version)}`,
    );
    if (response.status === 404) return false;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap((ok) => ok.json),
    );
    return typeof body === "object" && body !== null && "version" in body
      ? body.version === version
      : false;
  });

/**
 * Whether `@rtvision/t3@<version>` is published on npm. A 404 is false; network and
 * registry errors stay unknown. Both re-check every few minutes, so a release
 * that lands later shows up without a reload.
 */
const npmReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make(npmReleasePublished(version).pipe(Effect.provide(FetchHttpClient.layer))).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`npm-release-published:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("npm-release-published:none"),
);

/** True only once npm confirms the version, so callers can hide work that
    would download it until then. */
export function useNpmReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? npmReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
