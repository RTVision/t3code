import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "@t3tools/source-control-definitions/gitea";

import * as GiteaCli from "./GiteaCli.ts";
import * as GiteaPullRequestApi from "../pullRequest/GiteaPullRequestApi.ts";
import * as GiteaPullRequestProvider from "../pullRequest/GiteaPullRequestProvider.ts";
import * as GiteaSourceControlProvider from "./GiteaSourceControlProvider.ts";

const services = GiteaPullRequestApi.layer.pipe(Layer.provideMerge(GiteaCli.layer), Layer.orDie);

const makeInstance = Effect.all({
  sourceControl: GiteaSourceControlProvider.make,
  discovery: GiteaSourceControlProvider.makeDiscovery,
  pullRequests: GiteaPullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
