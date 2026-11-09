import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { MessageCircle, Pencil, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  PullRequestMarkdownTextarea,
  type PullRequestCompletionScope,
} from "~/components/pullRequest/PullRequestMarkdownTextarea";
import {
  SpeechTextField,
  TextFieldSpeechControls,
  type TextFieldSpeech,
} from "~/speech/useTextFieldSpeech";
import { textDirection } from "~/textDirection";

import { isCommentSubmitShortcut } from "./commentSubmitShortcut";

interface DiffCommentSecondaryAction {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly allowEmpty?: boolean;
  readonly onAction: (text: string) => void;
}

interface DiffCommentAnnotationProps {
  /** With an environment, the draft can be dictated; its project supplies vocabulary. */
  environmentId?: EnvironmentId | undefined;
  projectId?: ProjectId | null | undefined;
  ownerKey?: string;
  kind: "draft" | "comment";
  rangeLabel: string;
  text: string;
  onTextChange?: (text: string) => void;
  onCancel: () => void;
  onComment: (text: string) => void;
  onDelete?: () => void;
  /** Lets a saved comment reopen in the composer; called with the trimmed replacement text. */
  onEdit?: (text: string) => void;
  placeholder?: string;
  submitLabel?: string;
  pending?: boolean;
  secondaryAction?: DiffCommentSecondaryAction;
  focusOnMount?: boolean;
  /** Set only for pull request comments, where `@` completes the repository's users. */
  completionScope?: PullRequestCompletionScope | null;
}

export function DiffCommentAnnotation({
  environmentId,
  projectId,
  ownerKey,
  kind,
  rangeLabel,
  text,
  onTextChange,
  onCancel,
  onComment,
  onDelete,
  onEdit,
  placeholder = "Add a comment…",
  submitLabel = "Comment",
  pending = false,
  secondaryAction,
  focusOnMount = true,
  completionScope = null,
}: DiffCommentAnnotationProps) {
  const [localDraftText, setLocalDraftText] = useState("");
  // Non-null while a saved comment is being edited; holds the unsaved replacement text.
  const [editText, setEditText] = useState<string | null>(null);
  const editing = kind === "comment" && editText !== null;
  const displayedText = editing
    ? editText
    : kind === "draft" && !onTextChange
      ? localDraftText
      : text;
  const trimmedText = displayedText.trim();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldFocus = editing || (kind === "draft" && focusOnMount);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the draft textarea on the next animation frame after mount
  useLayoutEffect(() => {
    if (!shouldFocus) return;
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [shouldFocus]);

  if (kind === "comment" && !editing) {
    return (
      <div
        data-diff-comment-annotation
        className="group/comment flex min-w-0 items-start gap-2.5 border-s-2 border-primary/55 bg-primary/[0.045] px-3 py-2.5 font-sans text-foreground selection:bg-primary selection:text-primary-foreground"
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <MessageCircle className="size-3.5 h-5 shrink-0 text-primary/70" aria-hidden="true" />
        <p
          className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-5"
          dir={textDirection(displayedText)}
        >
          {displayedText}
        </p>
        {onEdit || onDelete ? (
          <span className="-my-1 -mr-1 flex shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
            {onEdit ? (
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label="Edit comment"
                onClick={() => setEditText(text)}
              >
                <Pencil className="size-3" />
              </Button>
            ) : null}
            {onDelete ? (
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label="Delete comment"
                onClick={onDelete}
              >
                <Trash2 className="size-3" />
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
    );
  }

  const cancel = editing ? () => setEditText(null) : onCancel;
  const saveComment = (value: string) => {
    if (!editing) {
      onComment(value);
      return;
    }
    setEditText(null);
    if (value !== text) onEdit?.(value);
  };

  const submit = (
    speech: TextFieldSpeech | undefined,
    action: (text: string) => void,
    allowEmpty = false,
  ) => {
    const finish = (value: string) => {
      if (!pending && (allowEmpty || value.trim())) action(value.trim());
    };
    if (speech) speech.submitAfterDictation(finish);
    else finish(displayedText);
  };

  // Pierre hides native carets and selection; textarea comments need their own visible feedback.
  const renderDraft = (speech?: TextFieldSpeech) => (
    <div
      data-diff-comment-annotation
      className="px-3 py-2 font-sans text-foreground caret-foreground selection:bg-primary selection:text-primary-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <PullRequestMarkdownTextarea
        ref={textareaRef}
        completionScope={completionScope}
        readOnly={speech?.freezesEditor}
        autoFocus={shouldFocus}
        size="sm"
        value={displayedText}
        dir={textDirection(displayedText)}
        placeholder={placeholder}
        aria-label={`${editing ? "Edit comment" : "Comment"} on lines ${rangeLabel}`}
        onValueChange={editing ? setEditText : (onTextChange ?? setLocalDraftText)}
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (speech && speech.state.phase !== "idle") speech.cancel();
            else cancel();
          }
          if (isCommentSubmitShortcut(event, trimmedText, pending, speech?.blocksSubmission)) {
            event.preventDefault();
            submit(speech, saveComment);
          }
        }}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="mr-auto text-3xs text-muted-foreground/70">
          ⌘/Ctrl Enter to {editing ? "save" : "send"}
        </span>
        {speech ? <TextFieldSpeechControls speech={speech} disabled={pending} /> : null}
        <Button variant="ghost-muted" size="xs" onClick={cancel}>
          Cancel
        </Button>
        {secondaryAction && !editing ? (
          <Button
            size="xs"
            variant="outline"
            disabled={
              speech?.preparing ||
              pending ||
              (!speech?.blocksSubmission && !secondaryAction.allowEmpty && !trimmedText)
            }
            onClick={() => submit(speech, secondaryAction.onAction, secondaryAction.allowEmpty)}
          >
            {secondaryAction.icon}
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={speech?.preparing || pending || (!speech?.blocksSubmission && !trimmedText)}
          onClick={() => submit(speech, saveComment)}
        >
          {editing ? "Save" : submitLabel}
        </Button>
      </div>
    </div>
  );

  return environmentId ? (
    <SpeechTextField
      environmentId={environmentId}
      projectId={projectId}
      ownerKey={ownerKey ?? rangeLabel}
      text={displayedText}
      textareaRef={textareaRef}
      onTextChange={editing ? setEditText : (onTextChange ?? setLocalDraftText)}
      disabled={pending}
    >
      {renderDraft}
    </SpeechTextField>
  ) : (
    renderDraft()
  );
}
