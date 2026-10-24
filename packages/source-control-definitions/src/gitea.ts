import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Forgejo from "@t3tools/source-control-forgejo/shared/definition";

const recognizeRemote = (input: Parameters<typeof Forgejo.definition.recognizeRemote>[0]) => {
  const recognized = Forgejo.definition.recognizeRemote(input);
  return recognized === null
    ? null
    : { ...recognized, kind: SourceControlProviderKind.make("gitea"), name: "Gitea" };
};

/** Gitea keeps its fork-specific API/provider behavior while sharing Forgejo's URL model. */
export const definition = {
  ...Forgejo.definition,
  kind: SourceControlProviderKind.make("gitea"),
  label: "Gitea",
  pickerLabel: "Gitea",
  publishDescription: "Configured server",
  publishHost: (signedInHost: string | null) => signedInHost ?? "your Gitea server",
  repositoryPathHint: "owner/repository",
  defaultCloneTransport: "ssh" as const,
  checkoutCommand: () => null,
  recognizeRemote,
};
