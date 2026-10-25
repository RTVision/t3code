import type {
  EnvironmentId,
  ProjectId,
  PullRequestRef,
  RepositoryIdentity,
} from "@t3tools/contracts";
import type { ChangeRequestLink } from "@t3tools/source-control-core/shared/definition";

import { sourceControlClients } from "./sourceControlClients.ts";

interface ChangeRequestProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

/** The project whose own repository holds the change request, not just one on its host. */
export function findProjectForChangeRequest<Project extends ChangeRequestProject>(
  projects: ReadonlyArray<Project>,
  link: ChangeRequestLink,
): Project | undefined {
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    return (
      identity?.provider !== undefined &&
      sourceControlClients.get(identity.provider).isChangeRequestInRepository(identity, link)
    );
  });
}

/** Returns null when a remote cannot authoritatively identify a Gitea web root. */
function giteaHttpRemoteMatchesLink(
  identity: RepositoryIdentity,
  link: ChangeRequestLink,
): boolean | null {
  try {
    const remote = new URL(identity.locator.remoteUrl.trim());
    if (remote.protocol !== "http:" && remote.protocol !== "https:") return null;
    if (remote.host.toLowerCase() !== (link.authority ?? link.host).toLowerCase()) return false;
    const remotePath = remote.pathname.split("/").filter((segment) => segment.length > 0);
    if (remotePath.length < 2) return false;
    remotePath[remotePath.length - 1] = remotePath.at(-1)!.replace(/\.git$/iu, "");
    if (remotePath.some((segment) => segment.length === 0)) return false;
    return (
      remotePath.slice(0, -2).join("/").toLowerCase() ===
      link.repository.split("/").slice(0, -2).join("/").toLowerCase()
    );
  } catch {
    return null;
  }
}

/** Prefers the project checked out from the link's repository, else lends any project on its host. */
export function findProjectOnChangeRequestHost<Project extends ChangeRequestProject>(
  projects: ReadonlyArray<Project>,
  link: ChangeRequestLink,
): Project | undefined {
  return (
    findProjectForChangeRequest(projects, link) ??
    projects.find((project) => {
      const identity = project.repositoryIdentity;
      if (identity?.provider === "gitea" || identity?.provider === "unknown") {
        const match = giteaHttpRemoteMatchesLink(identity, link);
        if (match !== null) return match;
        if (link.repository.split("/").length > 2) return false;
      }
      return (
        identity?.provider !== undefined &&
        sourceControlClients.get(identity.provider).canReadChangeRequestOnHost(identity, link)
      );
    })
  );
}

export interface ChangeRequestLinkCapabilities {
  readonly pullRequests?: boolean | undefined;
  readonly threadPullRequests?: boolean | undefined;
}

/**
 * Where every client opens a change request link in the app, or null for the browser. A link
 * opened into a pull request view may borrow any project on its host when the server reads
 * change requests by host, so a mirror's or a sibling repository's link still opens in the app.
 */
export function resolveChangeRequestLinkTarget<Project extends ChangeRequestProject>({
  url,
  projects,
  capabilities,
  environmentId,
  projectId,
  primaryEnvironmentId,
  lendHostProject,
}: {
  url: string;
  projects: ReadonlyArray<Project>;
  capabilities: (environmentId: EnvironmentId) => ChangeRequestLinkCapabilities | undefined;
  /** The link's own environment; without one, any environment that reads change requests. */
  environmentId?: EnvironmentId | undefined;
  /** The project the link came from, tried first. */
  projectId?: ProjectId | undefined;
  primaryEnvironmentId?: EnvironmentId | null | undefined;
  lendHostProject: boolean;
}): {
  readonly project: Project;
  readonly repository: string;
  readonly number: number;
  readonly host?: string;
} | null {
  const link = sourceControlClients.parseChangeRequestUrl(url)?.link;
  if (link === undefined) return null;
  // Matching remotes do not make project ids usable outside the link's environment.
  const candidates = (
    environmentId === undefined
      ? projects.filter((project) => capabilities(project.environmentId)?.pullRequests === true)
      : projects.filter((project) => project.environmentId === environmentId)
  ).sort(
    (left, right) =>
      Number(right.id === projectId) - Number(left.id === projectId) ||
      Number(right.environmentId === primaryEnvironmentId) -
        Number(left.environmentId === primaryEnvironmentId),
  );
  const project =
    findProjectForChangeRequest(candidates, link) ??
    (lendHostProject
      ? findProjectOnChangeRequestHost(
          candidates.filter(
            (candidate) => capabilities(candidate.environmentId)?.threadPullRequests === true,
          ),
          link,
        )
      : undefined);
  if (project === undefined) return null;
  const projectCapabilities = capabilities(project.environmentId);
  if (projectCapabilities?.pullRequests !== true) return null;
  return projectCapabilities.threadPullRequests === true
    ? {
        project,
        repository: link.repository,
        number: link.number,
        host: link.authority ?? link.host,
      }
    : {
        project,
        repository:
          sourceControlClients.repositorySelector(project.repositoryIdentity) ?? link.repository,
        number: link.number,
      };
}

export function resolvePullRequestPreviewTarget({
  environmentId,
  projects,
  pullRequestsEnabled,
  url,
}: {
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<ChangeRequestProject>;
  pullRequestsEnabled: boolean;
  url: string;
}): { environmentId: EnvironmentId; input: PullRequestRef } | null {
  if (!pullRequestsEnabled || environmentId === null) return null;
  const parsed = sourceControlClients.parseChangeRequestUrl(url)?.link;
  if (parsed === undefined) return null;
  const project = findProjectForChangeRequest(
    projects.filter((candidate) => candidate.environmentId === environmentId),
    parsed,
  );
  if (project === undefined) return null;
  return {
    environmentId,
    input: {
      projectId: project.id,
      host: parsed.authority ?? parsed.host,
      repository:
        sourceControlClients.repositorySelector(project.repositoryIdentity) ?? parsed.repository,
      number: parsed.number,
    },
  };
}

/** The project host's browser URL for one of its change requests, before its detail loads. */
export function projectChangeRequestUrl(
  identity: RepositoryIdentity | null | undefined,
  repository: string,
  number: number,
): string | null {
  if (identity?.provider === undefined) return null;
  const [host, ...path] = identity.canonicalKey.split("/");
  if (!host) return null;
  // The RPC selector can be shorter than the browser path (Azure's `web` for
  // `org/project/_git/web`), so the project's own repository uses its full key.
  const ownRepository = sourceControlClients.repositorySelector(identity) === repository;
  return sourceControlClients.get(identity.provider).changeRequestUrl({
    host,
    repository: ownRepository ? path.join("/") : repository,
    number,
    remoteUrl: identity.locator.remoteUrl.trim(),
    ...(ownRepository && identity.webUrl !== undefined ? { webUrl: identity.webUrl } : {}),
  });
}
