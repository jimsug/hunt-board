import { Users, useTracker, WhiteboardPresence } from "client/store";
import { MAX_COMMENT_LENGTH } from "lib/whiteboard/limits";
import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import Button from "react-bootstrap/Button";
import { useTranslation } from "react-i18next";
import styled, { css } from "styled-components";

const Row = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 6px;
`;

const EditorBox = styled.div`
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
`;

// On a phone the text is 16px, below which iOS zooms in on focus.
const TextArea = styled.textarea<{ $compact: boolean }>`
  display: block;
  width: 100%;
  max-height: 160px;
  padding: 4px 6px;
  border-radius: 4px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.fancyEditorBackground};
  color: inherit;
  font: inherit;
  resize: none;
  ${({ $compact }) =>
    $compact &&
    css`
      font-size: 16px;
    `}
`;

const SendButton = styled(Button)<{ $compact: boolean }>`
  ${({ $compact }) =>
    $compact &&
    css`
      min-height: 44px;
    `}
`;

const Suggestions = styled.ul`
  position: absolute;
  left: 0;
  bottom: 100%;
  z-index: 2;
  min-width: 160px;
  max-height: 160px;
  overflow-y: auto;
  margin: 0 0 2px;
  padding: 2px 0;
  list-style: none;
  border-radius: 4px;
  background: ${({ theme }) => theme.colors.autocompleteBackground};
  box-shadow: ${({ theme }) => theme.colors.autocompleteShadow};
`;

const Suggestion = styled.li<{ $active: boolean }>`
  padding: 2px 8px;
  cursor: pointer;
  background: ${({ $active, theme }) =>
    $active ? theme.colors.matchCandidateSelectedBackground : "transparent"};
`;

const MAX_SUGGESTIONS = 8;

// The @-name being typed at the caret, if any: its start and what's typed
function mentionAt(text: string, caret: number) {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return undefined;
  return { start: caret - match[1]!.length - 1, typed: match[1]! };
}

// A plain text box for writing a comment or a reply, in place of Jolly
// Roger's chat editor. Enter sends and Shift+Enter breaks the line; typing
// @ offers the names of the people on the board. What's sent is text:
// mentions are only the name, as the service has no mentions.
const CommentComposer = ({
  placeholder,
  autoFocus = false,
  compact = false,
  disabled = false,
  onSend,
  onHasTextChange,
}: {
  placeholder: string;
  // Takes focus when it first shows.
  autoFocus?: boolean;
  // Sized for a phone.
  compact?: boolean;
  // Keeps what's written but won't send it.
  disabled?: boolean;
  // Receives the text, and a callback for when the server refuses it, which
  // puts the text back if nothing new has been written since.
  onSend: (text: string, onRefused: () => void) => void;
  // Whether there's anything written that could be sent.
  onHasTextChange?: (hasText: boolean) => void;
}) => {
  const { t } = useTranslation();
  const listId = useId();
  const [text, setText] = useState("");
  // The latest text, for a refusal that arrives after more typing.
  const latest = useRef(text);
  const changeText = useCallback((next: string) => {
    latest.current = next;
    setText(next);
  }, []);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);

  const hasText = text.trim().length > 0;
  useEffect(() => {
    onHasTextChange?.(hasText);
  }, [hasText, onHasTextChange]);

  // Who can be @-named: everyone seen on the board, those here now first.
  const names = useTracker(() => {
    const here = new Set(WhiteboardPresence.find().map((p) => p.user));
    return Users.find()
      .fetch()
      .map((u) => u.displayName)
      .filter((name, i, all) => all.indexOf(name) === i)
      .toSorted((a, b) => a.localeCompare(b))
      .toSorted((a, b) => Number(here.has(b)) - Number(here.has(a)));
  }, []);
  const [caret, setCaret] = useState(0);
  const mention = useMemo(() => mentionAt(text, caret), [text, caret]);
  const suggestions = useMemo(() => {
    if (!mention) return [];
    const typed = mention.typed.toLowerCase();
    return names
      .filter((name) => name.toLowerCase().startsWith(typed))
      .slice(0, MAX_SUGGESTIONS);
  }, [mention, names]);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [suggestions]);

  const trackCaret = useCallback(() => {
    setCaret(textarea.current?.selectionStart ?? 0);
  }, []);
  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      changeText(event.target.value);
      setCaret(event.target.selectionStart);
    },
    [changeText],
  );

  const complete = useCallback(
    (name: string) => {
      if (!mention) return;
      const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`;
      changeText(next);
      const at = mention.start + name.length + 2;
      requestAnimationFrame(() => {
        textarea.current?.setSelectionRange(at, at);
        setCaret(at);
        textarea.current?.focus();
      });
    },
    [mention, text, caret, changeText],
  );

  const send = useCallback(() => {
    if (disabled || !hasText) return false;
    const sent = text;
    changeText("");
    onSend(sent.trim(), () => {
      if (latest.current.trim().length > 0) return;
      changeText(sent);
      if (rowRef.current?.contains(document.activeElement)) {
        textarea.current?.focus();
      }
    });
    return true;
  }, [disabled, hasText, text, onSend, changeText]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (suggestions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive((i) => (i + 1) % suggestions.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((i) => (i + suggestions.length - 1) % suggestions.length);
          return;
        }
        if (event.key === "Tab" || event.key === "Enter") {
          event.preventDefault();
          complete(suggestions[active] ?? suggestions[0]!);
          return;
        }
        if (event.key === "Escape") {
          // Closes the list, not the panel
          event.preventDefault();
          changeText(`${text.slice(0, caret)} ${text.slice(caret)}`.trimEnd());
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    },
    [suggestions, active, complete, send, changeText, text, caret],
  );

  return (
    <Row ref={rowRef} className="nodrag nowheel">
      <EditorBox>
        {suggestions.length > 0 && (
          <Suggestions id={listId} role="listbox">
            {suggestions.map((name, i) => (
              <Suggestion
                key={name}
                role="option"
                aria-selected={i === active}
                $active={i === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  complete(name);
                }}
              >
                @{name}
              </Suggestion>
            ))}
          </Suggestions>
        )}
        <TextArea
          ref={textarea}
          $compact={compact}
          rows={2}
          value={text}
          maxLength={MAX_COMMENT_LENGTH}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-controls={suggestions.length > 0 ? listId : undefined}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onKeyUp={trackCaret}
          onClick={trackCaret}
        />
      </EditorBox>
      <SendButton
        size="sm"
        $compact={compact}
        onClick={send}
        disabled={disabled || !hasText}
      >
        {t("whiteboard.comments.send", "Send")}
      </SendButton>
    </Row>
  );
};

export default React.memo(CommentComposer);
