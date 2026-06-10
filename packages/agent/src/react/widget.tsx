import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { demo } from "../providers/demo.js";
import type {
  AgentMessage,
  AgentOptions,
  AgentProvider,
  AgentStatus,
  Json,
  ProviderToolDescriptor,
  ToolCallPart,
} from "../types.js";
import { injectWidgetStyles } from "./styles.js";
import { useAgent } from "./use-agent.js";

export interface AgentWidgetProps {
  /** Default: demo() — scripted, zero config; pill labels it non-removably. */
  provider?: AgentProvider;
  instructions?: string;
  maxIterations?: number;
  allowTools?: string[];
  denyTools?: string[];
  /** Default: in-widget approval card for taint-guard approvals. */
  onApproval?: AgentOptions["onApproval"];
  onUsage?: AgentOptions["onUsage"];
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  theme?: "light" | "dark" | "auto";
  title?: string;
  placeholder?: string;
  greeting?: string;
  /** Overrides the auto-derived suggestion chips. */
  suggestions?: string[];
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Single styling escape hatch — appended to the root element. */
  className?: string;
  /** Replace the tool-call card only; everything else stays. */
  renderToolCall?: (part: ToolCallPart) => ReactNode;
}

const BUSY_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "streaming",
  "running-tool",
  "awaiting-confirmation",
  "awaiting-approval",
]);

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function compactValue(value: unknown): string {
  const json = JSON.stringify(value) ?? "null";
  return json.length <= 24 ? json : `${json.slice(0, 23)}…`;
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    return message.parts
      .filter(
        (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
      )
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

/**
 * Floating in-page agent widget. SSR-safe: renders null on the server and on
 * the first client render (hydration match), then portals into document.body.
 */
export function AgentWidget(props: AgentWidgetProps): ReactNode {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return <AgentWidgetInner {...props} />;
}

interface PendingApproval {
  toolName: string;
  input: Json;
  resolve: (approved: boolean) => void;
}

function AgentWidgetInner(props: AgentWidgetProps): ReactNode {
  // Default provider: one demo() instance for the widget's lifetime.
  const fallbackProvider = useRef<AgentProvider | null>(null);
  if (props.provider === undefined && fallbackProvider.current === null) {
    fallbackProvider.current = demo();
  }
  const provider = props.provider ?? fallbackProvider.current!;

  // Taint-guard approvals: default to an in-widget approve/deny card.
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const externalApproval = props.onApproval;
  const onApproval = useMemo<NonNullable<AgentOptions["onApproval"]>>(() => {
    if (externalApproval) return externalApproval;
    return (req) =>
      new Promise<boolean>((resolve) => {
        setApproval({ toolName: req.toolName, input: req.input, resolve });
      });
  }, [externalApproval]);

  const { messages, status, tools, error, send, stop } = useAgent({
    provider,
    instructions: props.instructions,
    maxIterations: props.maxIterations,
    allowTools: props.allowTools,
    denyTools: props.denyTools,
    onApproval,
    onUsage: props.onUsage,
  });
  const busy = BUSY_STATUSES.has(status);

  // Open state — controlled via `open` when provided, else internal.
  const [internalOpen, setInternalOpen] = useState(props.defaultOpen ?? false);
  const isControlled = props.open !== undefined;
  const open = isControlled ? props.open! : internalOpen;
  const onOpenChangeRef = useRef(props.onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = props.onOpenChange;
  });
  function setOpen(next: boolean): void {
    if (!isControlled) setInternalOpen(next);
    onOpenChangeRef.current?.(next);
  }

  useEffect(() => {
    injectWidgetStyles();
  }, []);

  // Focus: composer on open, back to the launcher on close.
  const launcherRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) composerRef.current?.focus();
    if (!open && wasOpen.current) launcherRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // Focus trap inside the panel — RELEASED while a page confirm UI is up so
  // the user can reach it; Escape closes.
  const trapActive = status !== "awaiting-confirmation";
  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key !== "Tab" || !trapActive) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Composer.
  const [draft, setDraft] = useState("");
  function dispatch(text: string): void {
    if (busy) return;
    // send() rejects only on send-while-running; `busy` guards the UI, and a
    // late race still must not surface an unhandled rejection.
    void send(text).catch(() => {});
  }
  function submit(): void {
    const text = draft.trim();
    if (text === "" || busy) return;
    setDraft("");
    dispatch(text);
  }

  // Suggested-prompt chips: explicit override, else derived from registered
  // tools (read-only first, description clipped to ~48 chars).
  const chips = useMemo(() => {
    if (props.suggestions) return props.suggestions.slice(0, 4);
    const sorted = [...tools].sort(
      (a, b) =>
        Number(b.annotations?.readOnlyHint === true) -
        Number(a.annotations?.readOnlyHint === true),
    );
    return sorted.slice(0, 4).map((t) => clip(t.description, 48));
  }, [props.suggestions, tools]);

  // aria-live announcements: response start, completed message text, and
  // tool/status changes — never individual tokens.
  const [announcement, setAnnouncement] = useState("");
  const prevStatus = useRef<AgentStatus>(status);
  useEffect(() => {
    const prev = prevStatus.current;
    if (prev === status) return;
    prevStatus.current = status;
    if (status === "streaming") {
      if (prev === "idle" || prev === "error") {
        setAnnouncement("Assistant is responding.");
      }
    } else if (status === "running-tool") {
      setAnnouncement("Running a tool on this page.");
    } else if (status === "awaiting-confirmation") {
      setAnnouncement("Waiting for your approval — check the page.");
    } else if (status === "awaiting-approval") {
      setAnnouncement("The assistant is asking permission to run a tool.");
    } else if (status === "idle") {
      const text = lastAssistantText(messages);
      setAnnouncement(text !== "" ? text : "Assistant finished.");
    } else {
      setAnnouncement(
        error
          ? `Something went wrong: ${error.message}`
          : "Something went wrong.",
      );
    }
  }, [status, messages, error]);

  // Sticky auto-scroll with a "Jump to latest" pill when scrolled up.
  const logRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  function onLogScroll(): void {
    const el = logRef.current;
    if (!el) return;
    setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 32);
  }
  useEffect(() => {
    const el = logRef.current;
    if (el && stickToBottom) el.scrollTop = el.scrollHeight;
  }, [messages, status, stickToBottom]);

  const title = props.title ?? "Assistant";
  const placeholder = props.placeholder ?? "Ask about this page…";
  const greeting =
    props.greeting ??
    "Hi! Ask me about this page — I can use its tools for you.";
  const streamingMessageId =
    status === "streaming" && messages.length > 0
      ? messages[messages.length - 1]!.id
      : null;

  const root = (
    <div
      className={props.className ? `wma-root ${props.className}` : "wma-root"}
      data-position={props.position ?? "bottom-right"}
      data-theme={props.theme ?? "auto"}
      data-open={open ? "true" : "false"}
    >
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={title}
          className="wma-panel"
          onKeyDown={onPanelKeyDown}
        >
          <header className="wma-header">
            <span className="wma-title">{title}</span>
            <span className="wma-pill" data-kind={provider.kind}>
              {provider.experimental
                ? `${provider.label} · experimental`
                : provider.label}
            </span>
            <button
              type="button"
              className="wma-close"
              aria-label="Close assistant"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>
          <div
            ref={logRef}
            role="log"
            aria-label="Conversation"
            className="wma-log"
            onScroll={onLogScroll}
          >
            {messages.length === 0 ? (
              <EmptyState
                greeting={greeting}
                tools={tools}
                chips={chips}
                onChip={dispatch}
              />
            ) : (
              messages.map((message) => (
                <MessageView
                  key={message.id}
                  message={message}
                  streaming={message.id === streamingMessageId}
                  renderToolCall={props.renderToolCall}
                />
              ))
            )}
            {approval !== null && (
              <ApprovalCard
                approval={approval}
                onDecision={(approved) => {
                  approval.resolve(approved);
                  setApproval(null);
                }}
              />
            )}
          </div>
          {!stickToBottom && (
            <button
              type="button"
              className="wma-jump"
              onClick={() => {
                const el = logRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                setStickToBottom(true);
              }}
            >
              Jump to latest
            </button>
          )}
          <form
            className="wma-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) stop();
              else submit();
            }}
          >
            <textarea
              ref={composerRef}
              className="wma-input"
              aria-label="Message"
              placeholder={placeholder}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <button
              type="submit"
              className="wma-send"
              data-busy={busy ? "true" : "false"}
              aria-label={busy ? "Stop" : "Send"}
            >
              {busy ? "Stop" : "Send"}
            </button>
          </form>
          <div className="wma-sr-only" aria-live="polite">
            {announcement}
          </div>
        </div>
      )}
      <button
        ref={launcherRef}
        type="button"
        className="wma-launcher"
        aria-expanded={open}
        aria-label={open ? "Close AI assistant" : "Open AI assistant"}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H13l-4.3 4.04A1 1 0 0 1 7 19.31V16H6.5A2.5 2.5 0 0 1 4 13.5v-8Z"
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
  );

  return createPortal(root, document.body);
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function EmptyState(props: {
  greeting: string;
  tools: ProviderToolDescriptor[];
  chips: string[];
  onChip: (text: string) => void;
}): ReactNode {
  return (
    <div className="wma-empty">
      <p className="wma-greeting">{props.greeting}</p>
      {props.tools.length > 0 && (
        <details className="wma-tools-disclosure">
          <summary>
            {props.tools.length} tool{props.tools.length === 1 ? "" : "s"} on
            this page
          </summary>
          <ul>
            {props.tools.map((t) => (
              <li key={t.name}>
                <code>{t.title ?? t.name}</code> — {t.description}
              </li>
            ))}
          </ul>
        </details>
      )}
      {props.chips.length > 0 && (
        <div className="wma-chips">
          {props.chips.map((chip, i) => (
            <button
              key={`${chip}-${i}`}
              type="button"
              className="wma-chip"
              onClick={() => props.onChip(chip)}
            >
              {chip}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageView(props: {
  message: AgentMessage;
  streaming: boolean;
  renderToolCall?: (part: ToolCallPart) => ReactNode;
}): ReactNode {
  const { message } = props;
  const role = message.role;
  if (role === "system-notice") {
    return (
      <div className="wma-notice" role="status">
        {message.parts
          .filter(
            (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
          )
          .map((p) => p.text)
          .join("\n")}
      </div>
    );
  }
  const lastIndex = message.parts.length - 1;
  return (
    <div className={`wma-message wma-message-${role}`}>
      {message.parts.map((part, index) =>
        part.type === "text" ? (
          <TextBubble
            key={index}
            text={part.text}
            role={role}
            caret={props.streaming && index === lastIndex}
          />
        ) : props.renderToolCall ? (
          <Fragment key={part.id}>{props.renderToolCall(part)}</Fragment>
        ) : (
          <ToolCallCard key={part.id} part={part} />
        ),
      )}
    </div>
  );
}

function TextBubble(props: {
  text: string;
  role: "user" | "assistant";
  caret: boolean;
}): ReactNode {
  // Plain text only — paragraphs and line breaks, no markdown.
  const paragraphs = props.text.split(/\n{2,}/);
  return (
    <div className={`wma-bubble wma-bubble-${props.role}`}>
      {paragraphs.map((paragraph, i) => (
        <p key={i}>
          {paragraph.split("\n").map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {line}
            </Fragment>
          ))}
          {props.caret && i === paragraphs.length - 1 && (
            <span className="wma-caret" aria-hidden="true" />
          )}
        </p>
      ))}
    </div>
  );
}

const GLYPHS: Record<ToolCallPart["state"], string> = {
  running: "",
  "awaiting-confirmation": "⧖",
  "awaiting-approval": "⧖",
  success: "✓",
  error: "✕",
  denied: "⊘",
};

function ToolCallCard({ part }: { part: ToolCallPart }): ReactNode {
  // Collapsed by default; errors expand themselves.
  const [expanded, setExpanded] = useState(part.state === "error");
  const sawError = useRef(part.state === "error");
  useEffect(() => {
    if (part.state === "error" && !sawError.current) setExpanded(true);
    sawError.current = part.state === "error";
  }, [part.state]);

  // Elapsed counter, shown after 2s while the call is still in flight.
  const active =
    part.state === "running" ||
    part.state === "awaiting-confirmation" ||
    part.state === "awaiting-approval";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  const elapsedMs = (part.endedAt ?? now) - part.startedAt;
  const showElapsed = active && elapsedMs >= 2000;

  const argEntries = Object.entries(part.input).slice(0, 2);
  const argSummary = argEntries
    .map(([key, value]) => `${key}: ${compactValue(value)}`)
    .join(" · ");

  return (
    <div className="wma-tool-card" data-state={part.state}>
      <button
        type="button"
        className="wma-tool-head"
        aria-expanded={expanded}
        aria-label={`Tool call: ${part.title}, ${part.state}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          className="wma-tool-glyph"
          data-state={part.state}
          aria-hidden="true"
        >
          {part.state === "running" ? (
            <span className="wma-spinner" />
          ) : (
            GLYPHS[part.state]
          )}
        </span>
        <span className="wma-tool-title">{part.title}</span>
        {argSummary !== "" && (
          <span className="wma-tool-args">{argSummary}</span>
        )}
        {!part.readOnly && (
          <span className="wma-badge wma-badge-writes">writes</span>
        )}
        {part.untrusted && (
          <span className="wma-badge wma-badge-untrusted">untrusted</span>
        )}
        {showElapsed && (
          <span className="wma-tool-elapsed">
            {Math.floor(elapsedMs / 1000)}s
          </span>
        )}
        <span
          className="wma-chevron"
          data-expanded={expanded}
          aria-hidden="true"
        >
          ›
        </span>
      </button>
      {part.state === "awaiting-confirmation" && (
        <p className="wma-tool-wait">
          Waiting for your approval — check the page.
        </p>
      )}
      {part.state === "denied" && (
        <p className="wma-tool-denied">Denied — this action was not run.</p>
      )}
      {expanded && (
        <div className="wma-tool-detail">
          <pre className="wma-pre">{JSON.stringify(part.input, null, 2)}</pre>
          {part.result !== undefined && <ResultBlock part={part} />}
        </div>
      )}
    </div>
  );
}

const RESULT_PREVIEW_CHARS = 2048;

function ResultBlock({ part }: { part: ToolCallPart }): ReactNode {
  const [showAll, setShowAll] = useState(false);
  const text = part.result!.content.map((c) => c.text).join("\n");
  const clipped = !showAll && text.length > RESULT_PREVIEW_CHARS;
  const pre = (
    <pre className="wma-pre">
      {clipped ? text.slice(0, RESULT_PREVIEW_CHARS) : text}
    </pre>
  );
  return (
    <div
      className="wma-tool-result"
      data-error={part.result!.isError === true ? "true" : undefined}
    >
      {part.untrusted ? <div className="wma-quoted">{pre}</div> : pre}
      {clipped && (
        <button
          type="button"
          className="wma-show-more"
          onClick={() => setShowAll(true)}
        >
          Show more ({text.length.toLocaleString()} chars)
        </button>
      )}
    </div>
  );
}

function ApprovalCard(props: {
  approval: PendingApproval;
  onDecision: (approved: boolean) => void;
}): ReactNode {
  const { toolName, input } = props.approval;
  return (
    <div
      className="wma-approval"
      role="group"
      aria-label={`Approve running ${toolName}`}
    >
      <p>
        The conversation contains untrusted page content. Allow the assistant to
        run <strong>{toolName}</strong>?
      </p>
      <pre className="wma-pre">{JSON.stringify(input, null, 2)}</pre>
      <div className="wma-approval-actions">
        <button
          type="button"
          className="wma-btn wma-btn-deny"
          onClick={() => props.onDecision(false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="wma-btn wma-btn-approve"
          onClick={() => props.onDecision(true)}
        >
          Allow
        </button>
      </div>
    </div>
  );
}
