import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded, type EnvironmentRpcInput } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";

export function createMcpAppEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    toolInfoQuery: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:mcp-apps:tool-info",
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.mcpAppsToolInfo>) =>
        requestGuarded(WS_METHODS.mcpAppsToolInfo, input),
    }),
    callTool: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:call-tool",
      tag: WS_METHODS.mcpAppsCallTool,
    }),
    toolInfo: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:tool-info",
      tag: WS_METHODS.mcpAppsToolInfo,
    }),
    readResource: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:read-resource",
      tag: WS_METHODS.mcpAppsReadResource,
    }),
    updateModelContext: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:update-model-context",
      tag: WS_METHODS.mcpAppsUpdateModelContext,
    }),
  };
}
