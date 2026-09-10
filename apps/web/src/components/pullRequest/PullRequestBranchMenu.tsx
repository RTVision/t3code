import type { PullRequestRef } from "@t3tools/contracts";
import { CheckIcon, GitBranchIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";
import type { DependencyChip, DependencyNavigation } from "./pullRequestDependencyNavigation.logic";

/** Read-only branch relationships for hosts and pull requests without a native stack. */
export function PullRequestBranchMenu({
  navigation,
  reference,
  refreshing,
  onSelect,
  onRetry,
}: {
  navigation: DependencyNavigation;
  reference: PullRequestRef;
  refreshing: boolean;
  onSelect: (reference: PullRequestRef) => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (navigation.status === "hidden" || navigation.status === "pending") return null;
  const notice =
    navigation.status === "unavailable" ||
    (navigation.status === "ready" && navigation.coverage === "unavailable")
      ? "Couldn't load branch relationships."
      : navigation.status === "partial-empty" ||
          (navigation.status === "ready" && navigation.coverage !== "complete")
        ? "Some branch relationships may be missing."
        : null;
  const choices = (label: string, chips: ReadonlyArray<DependencyChip>) =>
    chips.length > 0 ? (
      <MenuGroup>
        <MenuGroupLabel>{label}</MenuGroupLabel>
        {chips.map((chip) => (
          <MenuItem
            key={chip.number}
            disabled={refreshing}
            aria-current={chip.number === reference.number ? "true" : undefined}
            onClick={() => {
              setOpen(false);
              onSelect({ ...reference, number: chip.number });
            }}
          >
            {chip.state === null ? (
              <span>#{chip.number} · Details not loaded</span>
            ) : (
              <PullRequestStackLayerContent
                compact={chip.headBranch === null}
                layer={{
                  number: chip.number,
                  title: chip.title ?? "",
                  state: chip.state,
                  isDraft: chip.isDraft,
                  headBranch: chip.headBranch ?? "",
                }}
              />
            )}
            {chip.state !== null && chip.headBranch === null ? (
              <span className="text-xs text-muted-foreground">Source unknown</span>
            ) : null}
            {chip.number === reference.number ? (
              <CheckIcon aria-hidden className="size-3.5" />
            ) : null}
          </MenuItem>
        ))}
      </MenuGroup>
    ) : null;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger render={<Button variant="ghost" size="xs" />}>
              <GitBranchIcon aria-hidden className="size-3.5" />
              Related PRs
              {notice ? <TriangleAlertIcon aria-hidden className="size-3 text-warning" /> : null}
            </MenuTrigger>
          }
        />
        <TooltipPopup>Pull requests related by their base and head branches</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="w-96 max-w-[calc(100vw-2rem)]">
        <MenuGroupLabel>Inferred from branches</MenuGroupLabel>
        {notice ? <MenuGroupLabel>{notice}</MenuGroupLabel> : null}
        {notice ? (
          <MenuItem disabled={refreshing} onClick={onRetry}>
            Retry branch lookup
          </MenuItem>
        ) : null}
        {navigation.status === "ready" ? (
          <div className="max-h-80 overflow-y-auto">
            {navigation.cycleBefore || navigation.cycleAfter ? (
              <MenuGroupLabel>Branch cycle detected. Ordering stops at the cycle.</MenuGroupLabel>
            ) : null}
            {navigation.parentAmbiguous ? (
              <MenuGroupLabel>Parent is ambiguous.</MenuGroupLabel>
            ) : null}
            {navigation.truncatedAfter ? (
              <MenuGroupLabel>
                Open #{navigation.path.at(-1)?.number} to see more above.
              </MenuGroupLabel>
            ) : null}
            {choices("Branch chain", navigation.path.toReversed())}
            {navigation.truncatedBefore ? (
              <MenuGroupLabel>Open #{navigation.path[0]?.number} to see more below.</MenuGroupLabel>
            ) : navigation.rootBase ? (
              <MenuGroupLabel>↳ {navigation.rootBase}</MenuGroupLabel>
            ) : null}
            {choices(`Children of #${navigation.path.at(-1)?.number}`, navigation.children)}
            {choices("Siblings", navigation.siblings)}
            {choices("Possible parents", navigation.possibleParents)}
            {choices("Possible children", navigation.possibleChildren)}
          </div>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
