import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { cascadeRebaseStack } from "./githubStackRebase.ts";

const layer = Layer.mergeAll(
  Layer.mock(GitHubApi.GitHubApi)({
    credential: () => Effect.succeed({ token: Redacted.make("token"), fingerprint: "fp" }),
  }),
  VcsProcess.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * A bare "GitHub" holding the live-run stack: `main` moved ahead after the stack was cut, and a
 * second layer sits on the first. Returns each branch's head.
 */
const setup = Effect.fnUntraced(function* (advanceMain = true, thirdLayer = false) {
  const fs = yield* FileSystem.FileSystem;
  const process = yield* VcsProcess.VcsProcess;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cascade-test-" });
  const remote = `${root}/remote.git`;
  const work = `${root}/work`;
  const git = (cwd: string, ...args: string[]) =>
    process
      .run({
        operation: "test",
        command: "git",
        args,
        cwd,
        env: {
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      })
      .pipe(Effect.map((out) => out.stdout.trim()));
  const write = (path: string, text: string) => fs.writeFileString(`${work}/${path}`, text);
  yield* git(root, "init", "--quiet", "--bare", "-b", "main", remote);
  yield* git(root, "clone", "--quiet", remote, work);
  yield* write("index.ts", "export const answer = 41;\n");
  yield* git(work, "add", "-A");
  yield* git(work, "commit", "--quiet", "-m", "Initial");
  yield* git(work, "switch", "--quiet", "-c", "feat/answer-42");
  yield* write("index.ts", "export const answer = 42;\n");
  yield* git(work, "commit", "--quiet", "-am", "A: set the answer to 42");
  yield* git(work, "switch", "--quiet", "-c", "feat/answer-doc");
  yield* write("index.ts", "/** The answer. */\nexport const answer = 42;\n");
  yield* git(work, "commit", "--quiet", "-am", "B: document the answer");
  if (thirdLayer) {
    yield* git(work, "switch", "--quiet", "-c", "feat/answer-example");
    yield* write("example.ts", "export const example = 42;\n");
    yield* git(work, "add", "-A");
    yield* git(work, "commit", "--quiet", "-m", "C: add an example");
  }
  yield* git(work, "switch", "--quiet", "main");
  if (advanceMain) {
    yield* write("README.md", "main moved ahead\n");
    yield* git(work, "add", "-A");
    yield* git(work, "commit", "--quiet", "-m", "Docs");
  }
  yield* git(work, "push", "--quiet", "origin", "main", "feat/answer-42", "feat/answer-doc");
  if (thirdLayer) yield* git(work, "push", "--quiet", "origin", "feat/answer-example");
  const head = (branch: string) => git(remote, "rev-parse", `refs/heads/${branch}`);
  return {
    remote,
    root,
    head,
    pushConcurrentChange: Effect.fnUntraced(function* (branch: string) {
      yield* git(work, "fetch", "--quiet", "origin");
      yield* git(work, "switch", "--quiet", branch);
      yield* git(work, "reset", "--quiet", "--hard", `origin/${branch}`);
      yield* write("concurrent.txt", "Another writer advanced this branch.\n");
      yield* git(work, "add", "-A");
      yield* git(work, "commit", "--quiet", "-m", "Concurrent parent change");
      yield* git(work, "push", "--quiet", "origin", branch);
    }),
    git: (...args: string[]) => git(remote, ...args),
    layers: [
      { number: 1, headBranch: "feat/answer-42", headSha: yield* head("feat/answer-42") },
      { number: 2, headBranch: "feat/answer-doc", headSha: yield* head("feat/answer-doc") },
      ...(thirdLayer
        ? [
            {
              number: 3,
              headBranch: "feat/answer-example",
              headSha: yield* head("feat/answer-example"),
            },
          ]
        : []),
    ],
  };
});

it.layer(layer)("cascadeRebaseStack", (it) => {
  it.effect("moves each layer's own commits onto the rebased layer below it", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      const completed = yield* cascadeRebaseStack({
        host: "github.com",
        repository: "acme/web",
        base: "main",
        layers: repo.layers,
        remote: repo.remote,
      });
      assert.strictEqual(completed, 2);

      const main = yield* repo.head("main");
      const bottom = yield* repo.head("feat/answer-42");
      const top = yield* repo.head("feat/answer-doc");
      // Bottom sits on the new main; top sits on the new bottom with only its own commit.
      expect(yield* repo.git("rev-parse", `${bottom}~1`)).toBe(main);
      expect(yield* repo.git("rev-parse", `${top}~1`)).toBe(bottom);
      expect(yield* repo.git("log", "--format=%s", `${bottom}..${top}`)).toBe(
        "B: document the answer",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to overwrite a layer pushed after it was reviewed", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      const stale = [
        repo.layers[0]!,
        // Reviewed at the bottom layer's head, but the branch is really at its own commit.
        { ...repo.layers[1]!, headSha: repo.layers[0]!.headSha },
      ];
      const error = yield* Effect.flip(
        cascadeRebaseStack({
          host: "github.com",
          repository: "acme/web",
          base: "main",
          layers: stale,
          remote: repo.remote,
        }),
      );
      expect(error).toMatchObject({
        _tag: "GitHubStackRebaseChangedError",
        number: 2,
        completed: 1,
      });
      expect(yield* repo.head("feat/answer-doc")).toBe(repo.layers[1]!.headSha);
    }).pipe(Effect.scoped),
  );

  it.effect("stops at a conflicting layer and leaves it untouched", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      // Make main conflict with the bottom layer's change to the same line.
      const fs = yield* FileSystem.FileSystem;
      const process = yield* VcsProcess.VcsProcess;
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cascade-conflict-" });
      const run = (...args: string[]) =>
        process.run({
          operation: "test",
          command: "git",
          args,
          cwd: scratch,
          env: {
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        });
      yield* run("clone", "--quiet", repo.remote, ".");
      yield* fs.writeFileString(`${scratch}/index.ts`, "export const answer = 43;\n");
      yield* run("commit", "--quiet", "-am", "Conflict");
      yield* run("push", "--quiet", "origin", "main");

      const error = yield* Effect.flip(
        cascadeRebaseStack({
          host: "github.com",
          repository: "acme/web",
          base: "main",
          layers: repo.layers,
          remote: repo.remote,
        }),
      );
      expect(error).toMatchObject({
        _tag: "GitHubStackRebaseConflictError",
        number: 1,
        completed: 0,
      });
      expect(yield* repo.head("feat/answer-42")).toBe(repo.layers[0]!.headSha);
    }).pipe(Effect.scoped),
  );
  it.effect.each(["rebased parent", "unchanged parent", "earlier parent", "last push"] as const)(
    "detects a concurrent push after processing %s",
    (scenario) =>
      Effect.gen(function* () {
        const repo = yield* setup(scenario !== "unchanged parent", scenario === "earlier parent");
        const process = yield* VcsProcess.VcsProcess;
        let injected = false;
        const triggerBranch =
          scenario === "earlier parent"
            ? repo.layers[1]!.headBranch
            : scenario === "last push"
              ? repo.layers[1]!.headBranch
              : repo.layers[0]!.headBranch;
        const error = yield* Effect.flip(
          cascadeRebaseStack({
            host: "github.com",
            repository: "acme/web",
            base: "main",
            layers: repo.layers,
            remote: repo.remote,
          }).pipe(
            Effect.provideService(VcsProcess.VcsProcess, {
              run: (input) =>
                process.run(input).pipe(
                  Effect.tap(() => {
                    const trigger =
                      scenario === "unchanged parent"
                        ? input.args[0] === "checkout" &&
                          input.args.at(-1) === repo.layers[1]!.headSha
                        : input.args[0] === "push" &&
                          input.args.at(-1)?.endsWith(`:refs/heads/${triggerBranch}`);
                    if (injected || !trigger) return Effect.void;
                    injected = true;
                    return repo.pushConcurrentChange(repo.layers[0]!.headBranch);
                  }),
                ),
            }),
          ),
        );
        expect(injected).toBe(true);
        const completed = scenario === "earlier parent" || scenario === "last push" ? 2 : 1;
        expect(error).toMatchObject({
          _tag: "GitHubStackRebaseChangedError",
          number: 1,
          completed,
        });
        const unpublished = repo.layers[completed];
        if (unpublished) expect(yield* repo.head(unpublished.headBranch)).toBe(unpublished.headSha);
        expect(
          yield* repo.git("show", `${yield* repo.head(repo.layers[0]!.headBranch)}:concurrent.txt`),
        ).toBe("Another writer advanced this branch.");
      }).pipe(Effect.scoped),
  );

  it.effect.each([0, 1])(
    "reports a signing failure after %s layers and preserves its evidence",
    (completed) =>
      Effect.gen(function* () {
        const repo = yield* setup();
        const fs = yield* FileSystem.FileSystem;
        const process = yield* VcsProcess.VcsProcess;
        const config = `${repo.root}/signing.gitconfig`;
        yield* fs.writeFileString(
          config,
          "[commit]\n gpgsign = true\n[gpg]\n format = openpgp\n program = /bin/false\n[user]\n signingkey = DUMMY-CONTROL-KEY\n",
        );
        let rebases = 0;
        const error = yield* Effect.flip(
          cascadeRebaseStack({
            host: "github.com",
            repository: "acme/web",
            base: "main",
            layers: repo.layers,
            remote: repo.remote,
          }).pipe(
            Effect.provideService(VcsProcess.VcsProcess, {
              run: (input) => {
                if (input.args[0] === "rebase" && input.args[1] !== "--abort") rebases++;
                return process.run({
                  ...input,
                  env: {
                    ...input.env,
                    GIT_CONFIG_GLOBAL: rebases > completed ? config : "/dev/null",
                    GIT_CONFIG_NOSYSTEM: "1",
                  },
                });
              },
            }),
          ),
        );
        expect(error).toMatchObject({
          _tag: "GitHubStackRebaseGitError",
          number: completed + 1,
          completed,
          step: "rebasing",
          cause: {
            exitCode: 1,
            stderr: expect.stringContaining("failed to write commit object"),
          },
        });
        expect(error.message).not.toContain("conflicts");
        for (const original of repo.layers.slice(completed))
          expect(yield* repo.head(original.headBranch)).toBe(original.headSha);
        if (completed > 0)
          expect(yield* repo.head(repo.layers[0]!.headBranch)).not.toBe(repo.layers[0]!.headSha);
      }).pipe(Effect.scoped),
  );

  it.effect("retains the target lease when the child changes after checking its head", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      const process = yield* VcsProcess.VcsProcess;
      let injected = false;
      const top = repo.layers[1]!;
      const error = yield* Effect.flip(
        cascadeRebaseStack({
          host: "github.com",
          repository: "acme/web",
          base: "main",
          layers: repo.layers,
          remote: repo.remote,
        }).pipe(
          Effect.provideService(VcsProcess.VcsProcess, {
            run: (input) =>
              process.run(input).pipe(
                Effect.tap(() => {
                  if (
                    injected ||
                    input.args[0] !== "ls-remote" ||
                    !input.args.includes(`refs/heads/${top.headBranch}`)
                  )
                    return Effect.void;
                  injected = true;
                  return repo.pushConcurrentChange(top.headBranch);
                }),
              ),
          }),
        ),
      );
      expect(error).toMatchObject({
        _tag: "GitHubStackRebaseGitError",
        step: "pushing",
        number: 2,
        completed: 1,
      });
      expect(injected).toBe(true);
      expect(yield* repo.git("show", `${yield* repo.head(top.headBranch)}:concurrent.txt`)).toBe(
        "Another writer advanced this branch.",
      );
    }).pipe(Effect.scoped),
  );
});
