import { SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as GiteaPullRequestProvider from "../pullRequest/GiteaPullRequestProvider.ts";
import * as GiteaSourceControlProvider from "./GiteaSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("gitea"),
  make: Effect.all({
    sourceControl: GiteaSourceControlProvider.make,
    discovery: GiteaSourceControlProvider.makeDiscovery,
    pullRequests: GiteaPullRequestProvider.make,
  }),
});
