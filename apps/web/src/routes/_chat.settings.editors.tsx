import { createFileRoute } from "@tanstack/react-router";
import { EditorsSettingsPanel } from "../components/settings/EditorsSettings";

export const Route = createFileRoute("/_chat/settings/editors")({
  component: EditorsSettingsPanel,
});
