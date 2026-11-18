import { useAtomCommand } from "~/state/use-atom-command";
import type {
  EnvironmentId,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestRef,
} from "@t3tools/contracts";
import { msg, useGT, useLocale, useMessages } from "gt-react";
import { SmilePlusIcon } from "lucide-react";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";

import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  applyPendingPullRequestReactions,
  type PendingPullRequestReaction,
  PULL_REQUEST_REACTION_ORDER,
  pullRequestReactionEmoji,
  pullRequestReactionName,
  pullRequestReactionTooltip,
  pullRequestReactionsSignature,
} from "@t3tools/client-runtime/pull-request-reactions";

const PILL_CLASS =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

const EMPTY_PENDING: ReadonlyMap<PullRequestReactionContent, PendingPullRequestReaction> =
  new Map();

/** Reaction pills with a picker. `onReact` resolves to whether the host saved the change. */
export function ReactionBar({
  reactions,
  canReact,
  canReactNow,
  onReact,
  className,
}: {
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  readonly canReact: boolean;
  readonly canReactNow?: () => boolean;
  readonly onReact: (content: PullRequestReactionContent, reacted: boolean) => Promise<boolean>;
  readonly className?: string | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const locale = useLocale();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState<{
    readonly signature: string;
    readonly values: ReadonlyMap<PullRequestReactionContent, PendingPullRequestReaction>;
  }>({ signature: "", values: EMPTY_PENDING });

  const signature = pullRequestReactionsSignature(reactions);
  const values = pending.signature === signature ? pending.values : EMPTY_PENDING;
  const shown = applyPendingPullRequestReactions(reactions, values);

  const current = { canReact, canReactNow, onReact, signature, values };
  const latest = useRef(current);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Retained click callbacks must use the current target and grant.
  useLayoutEffect(() => {
    latest.current = current;
  });
  const toggle = async (content: PullRequestReactionContent, reacted: boolean) => {
    const target = latest.current;
    if (!target.canReact || target.canReactNow?.() === false) return;
    const entry: PendingPullRequestReaction = { reacted };
    setPending({
      signature: target.signature,
      values: new Map([...target.values, [content, entry]]),
    });
    if (await target.onReact(content, reacted)) return;
    setPending((current) => {
      if (current.values.get(content) !== entry) return current;
      const next = new Map(current.values);
      next.delete(content);
      return { signature: current.signature, values: next };
    });
    toastManager.add({ type: "error", title: m(msg("The reaction could not be saved")) });
  };

  if (shown.length === 0 && !canReact) return null;

  return (
    <div className={cn("flex min-w-0 max-w-full flex-wrap items-center gap-1", className)}>
      {shown.map((reaction) => (
        <Tooltip key={reaction.content}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-pressed={reaction.viewerHasReacted}
                aria-label={gt("{reaction}, {count}", {
                  reaction: pullRequestReactionName(reaction.content, messages),
                  count: reaction.count,
                  $context: "reaction button: reaction name and how many people used it",
                })}
                disabled={!canReact}
                className={cn(
                  PILL_CLASS,
                  reaction.viewerHasReacted
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border/70 bg-muted/40 text-muted-foreground",
                  canReact ? "hover:border-primary/60" : "cursor-default",
                )}
                onClick={() => void toggle(reaction.content, !reaction.viewerHasReacted)}
              />
            }
          >
            <span aria-hidden>{pullRequestReactionEmoji(reaction.content)}</span>
            <span className="tabular-nums">{reaction.count}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">
            {pullRequestReactionTooltip(reaction, messages, locale)}
          </TooltipPopup>
        </Tooltip>
      ))}

      {canReact ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={gt("Add a reaction")}
                className={cn(
                  PILL_CLASS,
                  "border-border/70 px-1.5 text-muted-foreground hover:border-primary/60 hover:text-foreground",
                )}
              />
            }
          >
            <SmilePlusIcon aria-hidden className="size-3.5" />
          </PopoverTrigger>
          <PopoverPopup align="start" side="top" padding="compact">
            <div className="flex items-center gap-0.5">
              {PULL_REQUEST_REACTION_ORDER.map((content) => {
                const reacted =
                  shown.find((reaction) => reaction.content === content)?.viewerHasReacted ?? false;
                return (
                  <button
                    key={content}
                    type="button"
                    aria-pressed={reacted}
                    aria-label={pullRequestReactionName(content, messages)}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md text-base outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      reacted && "bg-primary/10",
                    )}
                    onClick={() => {
                      setPickerOpen(false);
                      void toggle(content, !reacted);
                    }}
                  >
                    <span aria-hidden>{pullRequestReactionEmoji(content)}</span>
                  </button>
                );
              })}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}

export function PullRequestReactionBar({
  reactions,
  canReact,
  subjectId,
  environmentId,
  reference,
  onRefresh,
  className,
}: {
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  readonly canReact: boolean;
  /** Omit to react to the pull request description. */
  readonly subjectId?: string | undefined;
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly onRefresh: () => void;
  readonly className?: string | undefined;
}) {
  const registry = useContext(RegistryContext);
  const permission = pullRequestEnvironment.setReaction.permissionAtom(environmentId);
  const canWrite = useAtomValue(permission);
  const setReaction = useAtomCommand(pullRequestEnvironment.setReaction, {
    reportFailure: false,
  });
  return (
    <ReactionBar
      reactions={reactions}
      canReact={canReact && canWrite}
      canReactNow={() => registry.get(permission)}
      className={className}
      onReact={async (content, reacted) => {
        const result = await setReaction({
          environmentId,
          input: {
            ...reference,
            ...(subjectId === undefined ? {} : { subjectId }),
            content,
            reacted,
          },
        });
        if (result._tag === "Failure") return false;
        onRefresh();
        return true;
      }}
    />
  );
}
