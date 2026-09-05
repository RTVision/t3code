/** A Gitea repository is always an owner and repository, never a nested group path. */
export function parseGiteaRepository(value: string): string | null {
  const parts = value
    .trim()
    .replace(/\.git$/u, "")
    .split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[\p{L}\p{N}_.-]+$/u.test(part) || part === "." || part === "..")
  ) {
    return null;
  }
  return parts.join("/");
}

/** Match only the configured forge; an SSH port is independent of its web port. */
export function giteaRepositoryFromRemote(remoteUrl: string, baseUrl: string): string | null {
  try {
    const base = new URL(baseUrl);
    const scp = /^[a-zA-Z0-9._-]+@([^:/]+):(.+)$/u.exec(remoteUrl.trim());
    if (scp) {
      return scp[1]?.toLowerCase() === base.hostname.toLowerCase()
        ? parseGiteaRepository(scp[2] ?? "")
        : null;
    }
    const remote = new URL(remoteUrl.trim());
    if (remote.protocol === "ssh:") {
      return remote.hostname.toLowerCase() === base.hostname.toLowerCase()
        ? parseGiteaRepository(decodeURIComponent(remote.pathname.replace(/^\//u, "")))
        : null;
    }
    const root = `${base.pathname.replace(/\/+$/u, "")}/`;
    if (remote.origin !== base.origin || !remote.pathname.startsWith(root)) return null;
    return parseGiteaRepository(decodeURIComponent(remote.pathname.slice(root.length)));
  } catch {
    return null;
  }
}

export function giteaRepositoryPath(repository: string): string {
  return `/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
}

export function giteaPullRequestNumber(
  reference: string,
  repository: string,
  baseUrl: string,
): number | null {
  const number = /^#?(\d+)$/u.exec(reference.trim())?.[1];
  if (number !== undefined) {
    const parsed = Number(number);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  try {
    const url = new URL(reference);
    const base = new URL(baseUrl);
    const expected = `${base.pathname.replace(/\/+$/u, "")}/${repository}/pulls/`;
    if (
      url.origin !== base.origin ||
      !url.pathname.toLowerCase().startsWith(expected.toLowerCase())
    )
      return null;
    const number = /^(\d+)(?:[/?#].*)?$/u.exec(
      url.pathname.slice(expected.length).replace(/\/$/u, ""),
    )?.[1];
    if (number === undefined) return null;
    const parsed = Number(number);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}
