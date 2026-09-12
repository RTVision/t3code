import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
  readCodexAccountId,
  resolveCodexAuthHome,
} from "./CodexProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("resolves the selected or shadow home ahead of inherited credentials", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const inherited = { CODEX_HOME: "/shared", HOME: "/user" };
    assert.strictEqual(
      yield* resolveCodexAuthHome(
        { homePath: "/shadow", environment: { CODEX_HOME: "/instance" } },
        inherited,
      ),
      "/shadow",
    );
    assert.strictEqual(
      yield* resolveCodexAuthHome({ environment: { CODEX_HOME: "/instance" } }, inherited),
      "/instance",
    );
    assert.strictEqual(yield* resolveCodexAuthHome({}, inherited), "/shared");
    assert.strictEqual(
      yield* resolveCodexAuthHome({ environment: { HOME: "/instance-user" } }, { HOME: "/user" }),
      path.join("/instance-user", ".codex"),
    );
    assert.strictEqual(
      yield* resolveCodexAuthHome({}, { HOME: "/user" }),
      path.join("/user", ".codex"),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "reads workspace identity from the selected home without treating API keys as subscriptions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-account-identity-" });
      for (const accountId of ["personal", "work"]) {
        const home = path.join(root, accountId);
        yield* fs.makeDirectory(home);
        yield* fs.writeFileString(
          path.join(home, "auth.json"),
          encodeJson({ tokens: { account_id: accountId } }),
        );
        assert.strictEqual(yield* readCodexAccountId(home), accountId);
      }
      yield* fs.writeFileString(
        path.join(root, "auth.json"),
        encodeJson({ OPENAI_API_KEY: "local-proxy" }),
      );
      assert.strictEqual(yield* readCodexAccountId(root), undefined);
      assert.strictEqual(yield* readCodexAccountId(path.join(root, "missing")), undefined);
      const payload = Buffer.from(
        encodeJson({
          "https://api.openai.com/auth": { chatgpt_account_id: "token-workspace" },
        }),
      ).toString("base64url");
      for (const [tokens, expected] of [
        [{ id_token: `header.${payload}.signature` }, "token-workspace"],
        [{ account_id: null, id_token: `header.${payload}.signature` }, "token-workspace"],
        [{ account_id: "explicit", id_token: `header.${payload}.signature` }, "explicit"],
        [{ id_token: "malformed" }, undefined],
      ] as const) {
        yield* fs.writeFileString(path.join(root, "auth.json"), encodeJson({ tokens }));
        assert.strictEqual(yield* readCodexAccountId(root), expected);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
