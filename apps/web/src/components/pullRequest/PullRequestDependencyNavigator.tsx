import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleDashedIcon,
  GitForkIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LayersIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DependencyChip, DependencyNavigation } from "./pullRequestDependencyNavigation.logic";

function stateIcon(chip: DependencyChip) {
  if (chip.isDraft) return <GitPullRequestDraftIcon aria-hidden className="size-3" />;
  if (chip.state === "merged") return <GitMergeIcon aria-hidden className="size-3" />;
  if (chip.state === "closed") return <GitPullRequestClosedIcon aria-hidden className="size-3" />;
  return null;
}
function chipLabel(chip: DependencyChip) {
  const suffix = chip.isDraft
    ? " (draft)"
    : chip.state && chip.state !== "open"
      ? ` (${chip.state})`
      : "";
  return `Open #${chip.number}${chip.title ? `: ${chip.title}` : ""}${suffix}`;
}
const Arrow = () => <ArrowLeftIcon aria-hidden className="size-3 shrink-0 opacity-60" />;
const Dot = () => (
  <span aria-hidden className="px-0.5 opacity-50">
    ·
  </span>
);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function DependencyChipButton({
  chip,
  onOpen,
}: {
  readonly chip: DependencyChip;
  readonly onOpen: (number: number) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className="h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            aria-label={chipLabel(chip)}
            onClick={() => onOpen(chip.number)}
          >
            {stateIcon(chip)}#{chip.number}
          </Button>
        }
      />
      <TooltipPopup side="top">{chip.title ?? "Details not loaded"}</TooltipPopup>
    </Tooltip>
  );
}

function DependencyChoiceChip({
  label,
  items,
  onOpen,
}: {
  readonly label: string;
  readonly items: ReadonlyArray<DependencyChip>;
  readonly onOpen: (number: number) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="ghost" className="h-5 shrink-0 gap-1 px-1.5 text-[11px]">
            <GitForkIcon aria-hidden className="size-3" />
            {label}
          </Button>
        }
      />
      <MenuPopup>
        {items.map((chip) => (
          <MenuItem key={chip.number} onClick={() => onOpen(chip.number)}>
            {stateIcon(chip)}
            <span className="font-mono">#{chip.number}</span>
            <span className="max-w-[16rem] truncate">{chip.title ?? "Not loaded"}</span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function NavButton({
  direction,
  target,
  disabledReason,
  disabled,
  onOpen,
}: {
  readonly direction: "parent" | "child";
  readonly target: number | null;
  readonly disabledReason: string;
  readonly disabled: boolean;
  readonly onOpen: (number: number) => void;
}) {
  const Icon = direction === "parent" ? ArrowLeftIcon : ArrowRightIcon;
  const label = target === null ? disabledReason : `Open ${direction} #${target}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={label}
              disabled={disabled || target === null}
              onClick={() => target !== null && onOpen(target)}
            >
              <Icon className="size-3.5" />
            </Button>
          </span>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function PullRequestDependencyNavButtons({
  navigation,
  refreshing,
  onOpenPullRequest,
}: {
  readonly navigation: DependencyNavigation;
  readonly refreshing: boolean;
  readonly onOpenPullRequest: (number: number) => void;
}) {
  if (navigation.status !== "ready") return null;
  const show =
    navigation.parent !== null ||
    navigation.child !== null ||
    navigation.children.length > 0 ||
    navigation.possibleParents.length > 0 ||
    navigation.parentAmbiguous;
  if (!show) return null;
  return (
    <>
      <NavButton
        direction="parent"
        target={navigation.parent}
        disabledReason={
          navigation.possibleParents.length > 0 || navigation.parentAmbiguous
            ? "Parent not confirmed"
            : "No confirmed parent"
        }
        disabled={refreshing}
        onOpen={onOpenPullRequest}
      />
      <NavButton
        direction="child"
        target={navigation.child}
        disabledReason={
          navigation.children.length > 0 && navigation.focusIndex === navigation.path.length - 1
            ? "Choose a child"
            : "No confirmed child"
        }
        disabled={refreshing}
        onOpen={onOpenPullRequest}
      />
    </>
  );
}

export function PullRequestDependencyRow({
  navigation,
  hostLabel,
  refreshing,
  onOpenPullRequest,
  onRetry,
}: {
  readonly navigation: DependencyNavigation;
  readonly hostLabel: string;
  readonly refreshing: boolean;
  readonly onOpenPullRequest: (number: number) => void;
  readonly onRetry?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLSpanElement>(null);
  const focusNumber =
    navigation.status === "ready" ? navigation.path[navigation.focusIndex]?.number : null;
  useLayoutEffect(() => {
    if (focusNumber === null) return;
    const track = trackRef.current;
    const chip = focusRef.current;
    if (!track || !chip) return;
    track.scrollLeft = chip.offsetLeft - (track.clientWidth - chip.offsetWidth) / 2;
  }, [focusNumber]);
  if (navigation.status === "hidden" || navigation.status === "pending") return null;
  const rowClass = "mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground";
  const retry = onRetry ? (
    <Button
      size="xs"
      variant="ghost"
      className="h-5 px-1.5"
      onClick={onRetry}
      disabled={refreshing}
    >
      Retry
    </Button>
  ) : null;
  if (navigation.status === "partial-empty")
    return (
      <nav aria-label="Pull request dependencies" className={rowClass}>
        <LayersIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">Dependencies not fully checked</span>
        {retry}
      </nav>
    );
  if (navigation.status === "unavailable")
    return (
      <nav aria-label="Pull request dependencies" className={rowClass}>
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">Couldn't load dependencies</span>
        {retry}
      </nav>
    );
  const first = navigation.path[0]!;
  const last = navigation.path.at(-1)!;
  return (
    <nav aria-label="Pull request dependencies" className={rowClass}>
      <LayersIcon aria-hidden className="size-3.5 shrink-0" />
      <div
        ref={trackRef}
        className="relative min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <ol
          aria-label="Confirmed dependency chain, base first"
          className="flex items-center gap-1 whitespace-nowrap"
        >
          {navigation.possibleParents.length > 0 ? (
            <li className="flex items-center gap-1">
              <DependencyChoiceChip
                label={plural(
                  navigation.possibleParents.length,
                  "possible parent",
                  "possible parents",
                )}
                items={navigation.possibleParents}
                onOpen={onOpenPullRequest}
              />
              <Dot />
            </li>
          ) : null}
          {navigation.rootBase ? (
            <li className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <code className="max-w-32 truncate font-mono text-[11px]">
                      {navigation.rootBase}
                    </code>
                  }
                />
                <TooltipPopup side="top">{navigation.rootBase}</TooltipPopup>
              </Tooltip>
              <Arrow />
            </li>
          ) : null}
          {navigation.truncatedBefore || navigation.cycleBefore ? (
            <li className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex h-5 items-center px-1 font-mono text-[11px]">
                      {navigation.cycleBefore ? (
                        <TriangleAlertIcon aria-hidden className="size-3" />
                      ) : (
                        "…"
                      )}
                    </span>
                  }
                />
                <TooltipPopup side="top">
                  {navigation.cycleBefore
                    ? "Dependency cycle. Navigation stops here."
                    : `More above. Open #${first.number} to continue.`}
                </TooltipPopup>
              </Tooltip>
              <Arrow />
            </li>
          ) : null}
          {navigation.path.map((chip, index) => (
            <li key={chip.number} className="flex items-center gap-1">
              {index === navigation.focusIndex ? (
                <span
                  ref={focusRef}
                  aria-current="page"
                  className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-accent px-1.5 font-mono text-[11px] font-medium text-foreground"
                >
                  {stateIcon(chip)}#{chip.number}
                </span>
              ) : (
                <DependencyChipButton chip={chip} onOpen={onOpenPullRequest} />
              )}
              {index < navigation.path.length - 1 ? <Arrow /> : null}
            </li>
          ))}
          {navigation.truncatedAfter || navigation.cycleAfter ? (
            <li className="flex items-center gap-1">
              <Arrow />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex h-5 items-center px-1 font-mono text-[11px]">
                      {navigation.cycleAfter ? (
                        <TriangleAlertIcon aria-hidden className="size-3" />
                      ) : (
                        "…"
                      )}
                    </span>
                  }
                />
                <TooltipPopup side="top">
                  {navigation.cycleAfter
                    ? "Dependency cycle. Navigation stops here."
                    : `More below. Open #${last.number} to continue.`}
                </TooltipPopup>
              </Tooltip>
            </li>
          ) : null}
          {navigation.children.length > 0 ? (
            <li className="flex items-center gap-1">
              <Arrow />
              <DependencyChoiceChip
                label={plural(navigation.children.length, "child", "children")}
                items={navigation.children}
                onOpen={onOpenPullRequest}
              />
            </li>
          ) : null}
          {navigation.possibleChildren.length > 0 ? (
            <li className="flex items-center gap-1">
              <Dot />
              <DependencyChoiceChip
                label={plural(
                  navigation.possibleChildren.length,
                  "possible child",
                  "possible children",
                )}
                items={navigation.possibleChildren}
                onOpen={onOpenPullRequest}
              />
            </li>
          ) : null}
          {navigation.siblings.length > 0 ? (
            <li className="flex items-center gap-1">
              <Dot />
              <DependencyChoiceChip
                label={plural(navigation.siblings.length, "sibling", "siblings")}
                items={navigation.siblings}
                onOpen={onOpenPullRequest}
              />
            </li>
          ) : null}
        </ol>
      </div>
      <span className="ml-auto inline-flex shrink-0 items-center gap-1">
        {navigation.native.status === "present" ? (
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button size="xs" variant="outline" className="h-5 gap-1 px-1.5 text-[11px]">
                        <LayersIcon aria-hidden className="size-3" />
                        <span className="hidden sm:inline">{hostLabel} </span>stack ·{" "}
                        {navigation.native.members.length}
                      </Button>
                    }
                  />
                }
              />
              <TooltipPopup side="top">
                Stack membership reported by {hostLabel}. Branch relationships are shown separately.
              </TooltipPopup>
            </Tooltip>
            <MenuPopup>
              {navigation.native.members.map((chip) => (
                <MenuItem
                  key={chip.number}
                  disabled={chip.number === focusNumber}
                  onClick={() => onOpenPullRequest(chip.number)}
                >
                  {stateIcon(chip)}
                  <span className="font-mono">#{chip.number}</span>
                  <span className="max-w-[16rem] truncate">{chip.title ?? "Not loaded"}</span>
                  {chip.number === focusNumber ? (
                    <span className="ml-auto text-muted-foreground">current</span>
                  ) : null}
                </MenuItem>
              ))}
              {navigation.native.coverage === "partial" ? (
                <MenuItem disabled>Some members not loaded</MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : navigation.native.status === "unavailable" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex h-5 items-center gap-1 rounded-md border border-dashed border-border px-1.5 text-[11px]">
                  <LayersIcon aria-hidden className="size-3" />
                  Stack unavailable
                </span>
              }
            />
            <TooltipPopup side="top">
              Could not read stack membership from {hostLabel}.
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {refreshing ? (
          <span className="inline-flex items-center gap-1">
            <LoaderCircleIcon aria-hidden className="size-3.5" />
            <span className="sr-only">Refreshing dependencies</span>
          </span>
        ) : navigation.coverage === "partial" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <CircleDashedIcon
                  aria-label="Some dependencies may be missing"
                  className="size-3.5"
                />
              }
            />
            <TooltipPopup side="top">Some dependencies may be missing</TooltipPopup>
          </Tooltip>
        ) : navigation.coverage === "unavailable" ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <TriangleAlertIcon aria-label="Couldn't load dependencies" className="size-3.5" />
                }
              />
              <TooltipPopup side="top">Couldn't load dependencies</TooltipPopup>
            </Tooltip>
            {retry}
          </>
        ) : null}
        <PullRequestDependencyNavButtons
          navigation={navigation}
          refreshing={refreshing}
          onOpenPullRequest={onOpenPullRequest}
        />
      </span>
    </nav>
  );
}
