import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AuthPairingLinks from "./AuthPairingLinks.ts";
import * as Sqlite from "./Sqlite.ts";

const layer = AuthPairingLinks.layer.pipe(Layer.provide(Sqlite.layerMemory));
const now = DateTime.makeUnsafe("2026-10-07T00:00:00.000Z");
const link = {
  id: "test-link",
  credential: "test-pairing-credential",
  method: "one-time-token",
  scopes: ["orchestration:read", "terminal:read"],
  subject: "one-time-token",
  label: null,
  proofKeyThumbprint: null,
  createdAt: now,
  expiresAt: DateTime.add(now, { hours: 1 }),
} satisfies AuthPairingLinks.CreateAuthPairingLinkInput;
const consume = {
  credential: link.credential,
  proofKeyThumbprint: null,
  consumedAt: now,
  now,
} satisfies AuthPairingLinks.ConsumeAuthPairingLinkInput;

it.effect("consumes an unscoped pairing request once with the production Node SQLite driver", () =>
  Effect.gen(function* () {
    const repository = yield* AuthPairingLinks.AuthPairingLinkRepository;
    yield* repository.create(link);
    const first = yield* repository.consumeAvailable(consume);
    expect(Option.isSome(first)).toBe(true);
    if (Option.isNone(first)) return;
    expect(first.value.scopes).toEqual(link.scopes);
    expect(first.value.consumedAt).toEqual(now);
    expect(yield* repository.consumeAvailable(consume)).toEqual(Option.none());
  }).pipe(Effect.provide(layer)),
);

it.effect("accepts a requested scope intersection without widening the stored grant", () =>
  Effect.gen(function* () {
    const repository = yield* AuthPairingLinks.AuthPairingLinkRepository;
    yield* repository.create(link);
    const consumed = yield* repository.consumeAvailable({
      ...consume,
      requestedScopes: ["orchestration:read", "access:write"],
    });
    expect(Option.isSome(consumed)).toBe(true);
    if (Option.isNone(consumed)) return;
    expect(consumed.value.scopes).toEqual(link.scopes);
    expect(yield* repository.consumeAvailable(consume)).toEqual(Option.none());
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps incompatible and empty scope requests available for a later valid exchange", () =>
  Effect.gen(function* () {
    const repository = yield* AuthPairingLinks.AuthPairingLinkRepository;
    yield* repository.create(link);
    expect(
      yield* repository.consumeAvailable({ ...consume, requestedScopes: ["access:write"] }),
    ).toEqual(Option.none());
    expect(yield* repository.consumeAvailable({ ...consume, requestedScopes: [] })).toEqual(
      Option.none(),
    );
    const remaining = yield* repository.getByCredential({ credential: link.credential });
    expect(Option.isSome(remaining)).toBe(true);
    if (Option.isNone(remaining)) return;
    expect(remaining.value.consumedAt).toBeNull();
    expect(
      Option.isSome(
        yield* repository.consumeAvailable({ ...consume, requestedScopes: ["terminal:read"] }),
      ),
    ).toBe(true);
    expect(yield* repository.consumeAvailable(consume)).toEqual(Option.none());
  }).pipe(Effect.provide(layer)),
);

it.effect("does not consume expired or revoked pairing links", () =>
  Effect.gen(function* () {
    const repository = yield* AuthPairingLinks.AuthPairingLinkRepository;
    yield* repository.create({ ...link, expiresAt: now });
    yield* repository.create({ ...link, id: "revoked", credential: "revoked-credential" });
    expect(yield* repository.revoke({ id: "revoked", revokedAt: now })).toBe(true);
    expect(yield* repository.consumeAvailable(consume)).toEqual(Option.none());
    expect(
      yield* repository.consumeAvailable({
        ...consume,
        credential: "revoked-credential",
        requestedScopes: ["orchestration:read"],
      }),
    ).toEqual(Option.none());
    const expired = yield* repository.getByCredential({ credential: link.credential });
    const revoked = yield* repository.getByCredential({ credential: "revoked-credential" });
    expect(Option.isSome(expired) && expired.value.consumedAt).toBeNull();
    expect(Option.isSome(revoked) && revoked.value.consumedAt).toBeNull();
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "preserves proof-bound links after rejected attempts and accepts only the bound proof",
  () =>
    Effect.gen(function* () {
      const repository = yield* AuthPairingLinks.AuthPairingLinkRepository;
      yield* repository.create({ ...link, proofKeyThumbprint: "bound-proof" });
      expect(yield* repository.consumeAvailable(consume)).toEqual(Option.none());
      expect(
        yield* repository.consumeAvailable({ ...consume, proofKeyThumbprint: "wrong-proof" }),
      ).toEqual(Option.none());
      expect(
        yield* repository.consumeAvailable({
          ...consume,
          proofKeyThumbprint: "bound-proof",
          requestedScopes: ["access:write"],
        }),
      ).toEqual(Option.none());
      const remaining = yield* repository.getByCredential({ credential: link.credential });
      expect(Option.isSome(remaining) && remaining.value.consumedAt).toBeNull();
      const consumed = yield* repository.consumeAvailable({
        ...consume,
        proofKeyThumbprint: "bound-proof",
        requestedScopes: ["orchestration:read"],
      });
      expect(Option.isSome(consumed)).toBe(true);
      if (Option.isNone(consumed)) return;
      expect(consumed.value.proofKeyThumbprint).toBe("bound-proof");
      expect(yield* repository.consumeAvailable(consume)).toEqual(Option.none());
    }).pipe(Effect.provide(layer)),
);
