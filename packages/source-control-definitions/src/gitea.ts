import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Forgejo from "@t3tools/source-control-forgejo/shared/definition";

const isGiteaHostname = (hostname: string): boolean => {
  const labels = hostname.split(".");
  return (
    (hostname === "gitea.com" || labels.includes("gitea")) &&
    !labels.some((label) => ["codeberg", "forgejo", "github", "gitlab"].includes(label))
  );
};

const recognizeRemote = (input: Parameters<typeof Forgejo.definition.recognizeRemote>[0]) => {
  if (!isGiteaHostname(input.hostname)) return null;
  return {
    kind: SourceControlProviderKind.make("gitea"),
    name: "Gitea",
    baseUrl: /^https?:/iu.test(input.remoteUrl)
      ? new URL(input.remoteUrl).origin
      : `https://${input.host}`,
  };
};

/** Gitea keeps its fork-specific API/provider behavior while sharing Forgejo's URL model. */
export const definition = {
  ...Forgejo.definition,
  kind: SourceControlProviderKind.make("gitea"),
  label: "Gitea",
  pickerLabel: "Gitea",
  publishDescription: "Configured server",
  publicHost: null,
  publishHost: (signedInHost: string | null) => signedInHost ?? "your Gitea server",
  repositoryPathHint: "owner/repository",
  defaultCloneTransport: "ssh" as const,
  checkoutCommand: () => null,
  parseChangeRequestUrl: (url: URL) =>
    isGiteaHostname(url.hostname) ? Forgejo.definition.parseChangeRequestUrl(url) : null,
  recognizeRemote,
};
