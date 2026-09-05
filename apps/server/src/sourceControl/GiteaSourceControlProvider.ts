import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  PositiveInt,
  SourceControlProviderError,
  TrimmedNonEmptyString,
  type ChangeRequest,
} from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as GiteaApi from "./GiteaApi.ts";
import {
  giteaPullRequestNumber,
  giteaRepositoryFromRemote,
  giteaRepositoryPath,
  parseGiteaRepository,
} from "./giteaRepository.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import type { SourceControlApiDiscoverySpec } from "./SourceControlProviderDiscovery.ts";

const Repository = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  clone_url: TrimmedNonEmptyString,
  ssh_url: TrimmedNonEmptyString,
  default_branch: Schema.optionalKey(Schema.String),
});
const Branch = Schema.Struct({
  ref: TrimmedNonEmptyString,
  repo: Schema.NullOr(Repository),
});
const PullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  draft: Schema.optionalKey(Schema.Boolean),
  updated_at: Schema.DateTimeUtcFromString,
  head: Branch,
  base: Branch,
});
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function normalizeRepositoryIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function sameRepositoryIdentity(left: string | undefined, right: string | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    normalizeRepositoryIdentity(left) === normalizeRepositoryIdentity(right)
  );
}

function toChangeRequest(pull: typeof PullRequest.Type): ChangeRequest {
  return {
    provider: "gitea",
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    baseRefName: pull.base.ref,
    headRefName: pull.head.ref,
    state: pull.merged ? "merged" : pull.state,
    ...(pull.draft === undefined ? {} : { isDraft: pull.draft }),
    updatedAt: Option.some(pull.updated_at),
    isCrossRepository:
      pull.head.repo === null ||
      pull.base.repo === null ||
      !sameRepositoryIdentity(pull.head.repo.full_name, pull.base.repo.full_name),
    headRepositoryNameWithOwner: pull.head.repo?.full_name ?? null,
    headRepositoryOwnerLogin: pull.head.repo?.full_name.split("/")[0] ?? null,
  };
}

export const makeDiscovery = Effect.map(
  GiteaApi.GiteaApi,
  (api): SourceControlApiDiscoverySpec => ({
    type: "api",
    kind: "gitea",
    label: "Gitea",
    installHint: GiteaApi.GITEA_SETUP_HINT,
    probeAuth: api.probeAuth,
    refineUnknownRemote: ({ context }) => {
      if (
        Option.isNone(api.baseUrl) ||
        giteaRepositoryFromRemote(context.remoteUrl, api.baseUrl.value, api.sshHosts) === null
      )
        return null;
      return { kind: "gitea", name: "Gitea", baseUrl: api.baseUrl.value };
    },
  }),
);

export const make = Effect.gen(function* () {
  const api = yield* GiteaApi.GiteaApi;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
  const fileSystem = yield* FileSystem.FileSystem;

  const failure = (operation: string, cwd: string, detail: string) =>
    new SourceControlProviderError({
      provider: "gitea",
      operation,
      cwd,
      detail,
    });
  const request = <S extends Schema.Top>(
    operation: string,
    cwd: string,
    path: string,
    schema: S,
    method: "GET" | "POST" = "GET",
    body?: string,
  ) =>
    api.request({ operation, path, method, ...(body === undefined ? {} : { body }) }).pipe(
      Effect.flatMap((response) => GiteaApi.decodeGiteaResponse(operation, schema, response)),
      Effect.mapError((error) => failure(operation, cwd, error.detail)),
    );

  const configuredBaseUrl = (cwd: string) =>
    Option.isSome(api.baseUrl)
      ? Effect.succeed(api.baseUrl.value)
      : Effect.fail(failure("resolveRepository", cwd, GiteaApi.GITEA_SETUP_HINT));

  const resolveRepository = Effect.fn("GiteaSourceControlProvider.resolveRepository")(
    function* (input: {
      readonly cwd: string;
      readonly repository?: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) {
      const baseUrl = yield* configuredBaseUrl(input.cwd);
      if (
        input.context !== undefined &&
        giteaRepositoryFromRemote(input.context.remoteUrl, baseUrl, api.sshHosts) === null
      ) {
        return yield* failure(
          "resolveRepository",
          input.cwd,
          "The remote does not belong to the configured Gitea server.",
        );
      }
      if (input.repository !== undefined) {
        const repository =
          parseGiteaRepository(input.repository) ??
          giteaRepositoryFromRemote(input.repository, baseUrl, api.sshHosts);
        if (repository !== null)
          return {
            repository,
            remoteName: input.context?.remoteName ?? "origin",
            remoteUrl: input.context?.remoteUrl ?? "",
          };
        return yield* failure(
          "resolveRepository",
          input.cwd,
          "Specify a Gitea repository as owner/repository or a URL on the configured server.",
        );
      }
      if (input.context !== undefined) {
        const repository = giteaRepositoryFromRemote(
          input.context.remoteUrl,
          baseUrl,
          api.sshHosts,
        );
        if (repository !== null)
          return {
            repository,
            remoteName: input.context.remoteName,
            remoteUrl: input.context.remoteUrl,
          };
      }
      const handle = yield* vcs
        .resolve({ cwd: input.cwd })
        .pipe(
          Effect.mapError(() =>
            failure("resolveRepository", input.cwd, "Could not inspect the workspace repository."),
          ),
        );
      const { remotes } = yield* handle.driver
        .listRemotes(input.cwd)
        .pipe(
          Effect.mapError(() =>
            failure("resolveRepository", input.cwd, "Could not read repository remotes."),
          ),
        );
      const candidates = remotes.flatMap((remote) => {
        const repository = giteaRepositoryFromRemote(remote.url, baseUrl, api.sshHosts);
        return repository === null
          ? []
          : [{ repository, remoteName: remote.name, remoteUrl: remote.url }];
      });
      const selected =
        candidates.find((candidate) => candidate.remoteName === "origin") ?? candidates[0];
      if (selected !== undefined) return selected;
      return yield* failure(
        "resolveRepository",
        input.cwd,
        "No remote belongs to the configured Gitea server.",
      );
    },
  );

  const getPullRequest = Effect.fn("GiteaSourceControlProvider.getPullRequest")(function* (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
  }) {
    const locator = yield* resolveRepository(input);
    const baseUrl = yield* configuredBaseUrl(input.cwd);
    const number = giteaPullRequestNumber(input.reference, locator.repository, baseUrl);
    if (number === null)
      return yield* failure(
        "getChangeRequest",
        input.cwd,
        "Specify a PR number or a PR URL in this Gitea repository.",
      );
    const pull = yield* request(
      "getChangeRequest",
      input.cwd,
      `${giteaRepositoryPath(locator.repository)}/pulls/${number}`,
      PullRequest,
    );
    return { locator, pull };
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: "gitea",
    listChangeRequests: Effect.fn("GiteaSourceControlProvider.listChangeRequests")(
      function* (input) {
        const { repository } = yield* resolveRepository(input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const refName =
          source?.refName ?? SourceControlProvider.normalizeSourceBranch(input.headSelector);
        const items: ChangeRequest[] = [];
        const limit = input.limit ?? 20;
        let page = 1;
        let scanned = 0;
        // Filter across provider pages: a matching branch may not be among the first 50 PRs.
        while (items.length < limit) {
          const query = new URLSearchParams({
            state: input.state === "merged" ? "closed" : input.state,
            sort: "recentupdate",
            page: String(page),
            limit: "50",
          });
          const response = yield* api
            .request({
              operation: "listChangeRequests",
              method: "GET",
              path: `${giteaRepositoryPath(repository)}/pulls?${query}`,
            })
            .pipe(
              Effect.mapError((error) => failure("listChangeRequests", input.cwd, error.detail)),
            );
          const pulls = yield* GiteaApi.decodeGiteaResponse(
            "listChangeRequests",
            Schema.Array(PullRequest),
            response,
          ).pipe(
            Effect.mapError((error) => failure("listChangeRequests", input.cwd, error.detail)),
          );
          for (const pull of pulls) {
            const item = toChangeRequest(pull);
            const headRepository = pull.head.repo?.full_name;
            if (
              item.headRefName !== refName ||
              (input.state !== "all" && item.state !== input.state)
            )
              continue;
            if (
              source?.owner !== undefined &&
              headRepository?.split("/")[0]?.toLowerCase() !== source.owner.toLowerCase()
            )
              continue;
            if (
              source?.repository !== undefined &&
              headRepository?.toLowerCase() !== source.repository.toLowerCase() &&
              headRepository?.split("/")[1]?.toLowerCase() !== source.repository.toLowerCase()
            )
              continue;
            items.push(item);
            if (items.length >= limit) break;
          }
          if (items.length >= limit) break;
          scanned += pulls.length;
          const hasNext = /rel="?next"?/u.test(response.headers.link ?? "");
          const total = Number(response.headers["x-total-count"]);
          if (
            pulls.length === 0 ||
            (!hasNext && (Number.isFinite(total) ? scanned >= total : pulls.length < 50))
          )
            break;
          if (page >= 100)
            return yield* failure(
              "listChangeRequests",
              input.cwd,
              "Too many Gitea PR pages to resolve this branch reliably.",
            );
          page += 1;
        }
        return items;
      },
    ),
    getChangeRequest: (input) =>
      getPullRequest(input).pipe(Effect.map(({ pull }) => toChangeRequest(pull))),
    createChangeRequest: Effect.fn("GiteaSourceControlProvider.createChangeRequest")(
      function* (input) {
        const { repository } = yield* resolveRepository(input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const targetRepository =
          input.target === undefined
            ? repository
            : input.target.repository !== undefined
              ? (parseGiteaRepository(input.target.repository) ??
                parseGiteaRepository(
                  `${input.target.owner ?? repository.split("/")[0]}/${input.target.repository}`,
                ))
              : input.target.owner === undefined
                ? repository
                : parseGiteaRepository(`${input.target.owner}/${repository.split("/")[1] ?? ""}`);
        if (targetRepository === null)
          return yield* failure("createChangeRequest", input.cwd, "Invalid target repository.");
        const body = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(
            Effect.mapError(() =>
              failure("createChangeRequest", input.cwd, "Could not read the PR description file."),
            ),
          );
        const sourceOwner =
          source?.owner ??
          (sameRepositoryIdentity(repository, targetRepository)
            ? undefined
            : repository.split("/")[0]);
        const sourceRefName = source?.refName ?? input.headSelector;
        const head = sourceOwner === undefined ? sourceRefName : `${sourceOwner}:${sourceRefName}`;
        yield* request(
          "createChangeRequest",
          input.cwd,
          `${giteaRepositoryPath(targetRepository)}/pulls`,
          PullRequest,
          "POST",
          encodeBody({
            title: input.title,
            body,
            head,
            base: input.target?.refName ?? input.baseRefName,
          }),
        );
      },
    ),
    getRepositoryCloneUrls: Effect.fn("GiteaSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const { repository } = yield* resolveRepository(input);
        const repo = yield* request(
          "getRepositoryCloneUrls",
          input.cwd,
          giteaRepositoryPath(repository),
          Repository,
        );
        return { nameWithOwner: repo.full_name, url: repo.clone_url, sshUrl: repo.ssh_url };
      },
    ),
    createRepository: Effect.fn("GiteaSourceControlProvider.createRepository")(function* (input) {
      const { repository } = yield* resolveRepository(input);
      const viewer = yield* request(
        "createRepository",
        input.cwd,
        "/user",
        Schema.Struct({ login: TrimmedNonEmptyString }),
      );
      const [owner, name] = repository.split("/");
      const path =
        owner?.toLowerCase() === viewer.login.toLowerCase()
          ? "/user/repos"
          : `/orgs/${encodeURIComponent(owner ?? "")}/repos`;
      const repo = yield* request(
        "createRepository",
        input.cwd,
        path,
        Repository,
        "POST",
        encodeBody({ name, private: input.visibility === "private", auto_init: false }),
      );
      return { nameWithOwner: repo.full_name, url: repo.clone_url, sshUrl: repo.ssh_url };
    }),
    getDefaultBranch: Effect.fn("GiteaSourceControlProvider.getDefaultBranch")(function* (input) {
      const { repository } = yield* resolveRepository(input);
      const repo = yield* request(
        "getDefaultBranch",
        input.cwd,
        giteaRepositoryPath(repository),
        Repository,
      );
      return repo.default_branch?.trim() || null;
    }),
    checkoutChangeRequest: Effect.fn("GiteaSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const { locator, pull } = yield* getPullRequest(input);
        if (pull.head.repo === null)
          return yield* failure(
            "checkoutChangeRequest",
            input.cwd,
            "The PR's source repository was deleted or is inaccessible.",
          );
        const sourceRepository = pull.head.repo;
        const crossRepository = !sameRepositoryIdentity(
          sourceRepository.full_name,
          locator.repository,
        );
        const baseUrl = yield* configuredBaseUrl(input.cwd);
        const remoteUrl = isSshRemoteUrl(locator.remoteUrl)
          ? sourceRepository.ssh_url
          : sourceRepository.clone_url;
        if (giteaRepositoryFromRemote(remoteUrl, baseUrl, api.sshHosts) === null)
          return yield* failure(
            "checkoutChangeRequest",
            input.cwd,
            "The PR's source repository is outside the configured Gitea server.",
          );
        const checkout = Effect.gen(function* () {
          const remoteName = crossRepository
            ? yield* git.ensureRemote({
                cwd: input.cwd,
                preferredName: sourceRepository.full_name.split("/")[0] ?? "gitea",
                url: remoteUrl,
              })
            : locator.remoteName;
          const localBranch = crossRepository
            ? `t3code/pr-${pull.number}/${sanitizeBranchFragment(pull.head.ref)}`
            : pull.head.ref;
          const existing = yield* git.listLocalBranchNames(input.cwd);
          if (input.force === true || !existing.includes(localBranch)) {
            yield* git.fetchRemoteBranch({
              cwd: input.cwd,
              remoteName,
              remoteBranch: pull.head.ref,
              localBranch,
            });
          } else {
            yield* git.fetchRemoteTrackingBranch({
              cwd: input.cwd,
              remoteName,
              remoteBranch: pull.head.ref,
            });
          }
          yield* git.setBranchUpstream({
            cwd: input.cwd,
            branch: localBranch,
            remoteName,
            remoteBranch: pull.head.ref,
          });
          yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
        });
        yield* checkout.pipe(
          Effect.mapError(() =>
            failure(
              "checkoutChangeRequest",
              input.cwd,
              "Could not check out this Gitea PR. Check Git credentials and local changes.",
            ),
          ),
        );
      },
    ),
  });
});
