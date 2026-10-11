import { SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlClient } from "@t3tools/source-control-core/client/definition";
import * as Forgejo from "@t3tools/source-control-forgejo/client/definition";

export const definition = defineSourceControlClient({
  ...Forgejo.definition,
  kind: SourceControlProviderKind.make("gitea"),
  label: "Gitea",
  pickerLabel: "Gitea",
  icon: "gitea",
  publishDescription: "Configured server",
  repositoryPathHint: "owner/repository",
  checkoutCommand: () => null,
});
