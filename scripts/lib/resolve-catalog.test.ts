import { assert, describe, it } from "@effect/vitest";

import { resolveCatalogDependencies, resolveServerPublishDependencies } from "./resolve-catalog.ts";

const catalog = { effect: "4.0.0-rc.115", "@clerk/backend": "3.18.1", react: "19.2.0" };

it("omits bundled private providers from npm metadata while retaining native and catalog dependencies", () => {
  const dependencies = {
    "@t3tools/provider-core": "workspace:*",
    "@t3tools/provider-opencode": "workspace:*",
    effect: "catalog:",
    "node-pty": "1.2.0-beta.15",
    "@cursor/sdk": "0.9.2",
  };
  assert.deepStrictEqual(resolveServerPublishDependencies(dependencies, catalog), {
    effect: catalog.effect,
    "node-pty": "1.2.0-beta.15",
    "@cursor/sdk": "0.9.2",
  });
  assert.strictEqual(dependencies["@t3tools/provider-core"], "workspace:*");
});

describe("resolveCatalogDependencies", () => {
  it("resolves bare, named and override-selector catalog specs like pnpm", () => {
    assert.deepStrictEqual(
      resolveCatalogDependencies(
        {
          "@clerk/backend": "catalog:",
          "react-dom": "catalog:react",
          "@opencode/protocol>effect": "catalog:",
          "dbus-next>usocket": "-",
          lodash: "4.17.21",
        },
        catalog,
        "apps/desktop",
      ),
      {
        "@clerk/backend": "3.18.1",
        "react-dom": "19.2.0",
        "@opencode/protocol>effect": "4.0.0-rc.115",
        "dbus-next>usocket": "-",
        lodash: "4.17.21",
      },
    );
  });

  it("fails on a catalog entry that does not exist", () => {
    assert.throws(
      () => resolveCatalogDependencies({ "a>missing": "catalog:" }, catalog, "apps/desktop"),
      /Expected key 'missing' in root workspace catalog/,
    );
  });

  it("resolves version-qualified overrides without changing their selectors", () => {
    assert.deepStrictEqual(
      resolveCatalogDependencies(
        {
          "undici@^8": "catalog:",
          "ws@^8": "catalog:",
          "@clerk/backend@^3": "catalog:",
          "@scope/parent@^1>undici@^8": "catalog:",
          "parent@^1>@clerk/backend@^3": "catalog:",
        },
        { ...catalog, undici: "8.11.2", ws: "8.21.0" },
        "apps/desktop",
      ),
      {
        "undici@^8": "8.11.2",
        "ws@^8": "8.21.0",
        "@clerk/backend@^3": "3.18.1",
        "@scope/parent@^1>undici@^8": "8.11.2",
        "parent@^1>@clerk/backend@^3": "3.18.1",
      },
    );
  });
});
