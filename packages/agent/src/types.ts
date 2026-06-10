import type {
  JsonSchema,
  ModelContextClient,
  ToolAnnotations,
  ToolResult,
} from "webmcp-tools";

export type {
  JsonSchema,
  ModelContextClient,
  ToolAnnotations,
  ToolResult,
} from "webmcp-tools";

/** Plain JSON object — tool inputs and structured payloads. */
export type Json = Record<string, unknown>;

/**
 * Transport/protocol failure from a provider. The agent loop converts thrown
 * `ProviderError`s into `error` events — it never rethrows them to callers.
 */
export class ProviderError extends Error {
  readonly status?: number;

  constructor(message: string, opts?: { status?: number; cause?: unknown }) {
    super(message);
    this.name = "ProviderError";
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface AgentProvider {
  /** "anthropic" | "proxy" | "builtin" | "demo" (custom providers: any id). */
  id: string;
  /** UI badge text; demo => "Demo (scripted — not AI)". */
  label: string;
  kind: "remote" | "on-device" | "scripted";
  /** builtin => true. */
  experimental?: boolean;
  chat(request: ProviderChatRequest): AsyncIterable<ProviderEvent>;
}

export interface ProviderChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ProviderToolDescriptor[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface ProviderToolDescriptor {
  name: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  /**
   * The agent loop appends "[read-only]" or "[mutates page state; may
   * require user confirmation]" before handing descriptors to the provider.
   */
  description: string;
  /** Display title (spec `ModelContextTool.title`); used for ToolCallPart.title. */
  title?: string;
}

export type ProviderEvent =
  | { type: "text-delta"; text: string }
  /** Emitted only once the input JSON is fully accumulated and parsed. */
  | { type: "tool-call"; id: string; name: string; input: Json }
  | {
      type: "done";
      stopReason: "end-turn" | "tool-use" | "max-tokens";
      usage?: { inputTokens: number; outputTokens: number };
    };

// ---------------------------------------------------------------------------
// Tool source (page-side discovery + execution)
// ---------------------------------------------------------------------------

export interface ToolSource {
  list(): ProviderToolDescriptor[];
  execute(
    name: string,
    input: Json,
    client: ModelContextClient,
  ): Promise<ToolResult>;
  subscribe(onChange: () => void): () => void;
}

export type DemoRule = {
  match: string | RegExp;
  toolCalls?: Array<{ name: string; input: Json }>;
  reply: string;
};

// ---------------------------------------------------------------------------
// Provider-facing conversation model (Anthropic-shaped, camelCase)
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Json }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

// ---------------------------------------------------------------------------
// Agent surface
// ---------------------------------------------------------------------------

export interface AnthropicOptions {
  /** Memory only; never persisted; redacted in thrown errors. */
  apiKey?: string;
  /** Default "https://api.anthropic.com". */
  baseURL?: string;
  /** Default: pinned non-thinking Sonnet. */
  model?: string;
  /**
   * REQUIRED when running in a window with an apiKey, otherwise anthropic()
   * THROWS. Even with it, a one-time console.warn points to proxy().
   */
  dangerouslyAllowBrowser?: boolean;
}

export interface AgentOptions {
  provider: AgentProvider;
  /** APPENDED after the fixed security preamble; no systemPrompt override. */
  instructions?: string;
  /** Hard cap of model calls per send(). Default 8. */
  maxIterations?: number;
  /** max_tokens per model call. Default 4096. */
  maxTokens?: number;
  /** Filtered at discovery AND execution; deny wins. */
  allowTools?: string[];
  denyTools?: string[];
  /** Default true; forced true for builtin(). */
  taintGuard?: boolean;
  /**
   * Taint-guard approval. Default: window.confirm in DOM, auto-DENY headless.
   */
  onApproval?: (req: {
    toolName: string;
    input: Json;
    reason: "tainted-context";
  }) => boolean | Promise<boolean>;
  onUsage?: (u: {
    inputTokens: number;
    outputTokens: number;
    cumulative: { inputTokens: number; outputTokens: number };
  }) => void;
  /** Default pageToolSource(). */
  toolSource?: ToolSource;
}

export type AgentStatus =
  | "idle"
  | "streaming"
  | "running-tool"
  | "awaiting-confirmation"
  | "awaiting-approval"
  | "error";

export interface TextPart {
  type: "text";
  /** Grows while streaming. */
  text: string;
}

export interface ToolCallPart {
  type: "tool-call";
  id: string;
  toolName: string;
  /** descriptor.title ?? name. */
  title: string;
  input: Json;
  state:
    | "running"
    | "awaiting-confirmation"
    | "awaiting-approval"
    | "success"
    | "error"
    | "denied";
  result?: ToolResult;
  /** annotations.readOnlyHint === true. */
  readOnly: boolean;
  /** annotations.untrustedContentHint === true. */
  untrusted: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface AgentMessage {
  id: string;
  /** Parts interleaved chronologically. */
  parts: Array<TextPart | ToolCallPart>;
  /** "system-notice" = caps, errors, aborts. */
  role: "user" | "assistant" | "system-notice";
}

export interface AgentState {
  status: AgentStatus;
  messages: AgentMessage[];
  /** Live via toolchange/registry events (filtered by allow/deny). */
  tools: ProviderToolDescriptor[];
}

export type AgentEvent =
  | { type: "user-message"; text: string }
  | { type: "assistant-delta"; text: string }
  /** Full text of the model turn. */
  | { type: "assistant-message"; text: string }
  | {
      type: "tool-call";
      id: string;
      name: string;
      input: Json;
      readOnly: boolean;
    }
  | {
      type: "tool-result";
      id: string;
      name: string;
      result: ToolResult;
      untrusted: boolean;
    }
  | { type: "confirm-pending"; toolCallId: string; toolName: string }
  | { type: "confirm-resolved"; toolCallId: string }
  | {
      type: "approval-required";
      toolCallId: string;
      toolName: string;
      input: Json;
    }
  | { type: "approval-resolved"; toolCallId: string; approved: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  /** Available tools changed (registry/toolchange); read getState().tools. */
  | { type: "tools-changed"; tools: ProviderToolDescriptor[] }
  | {
      type: "error";
      code: "iteration-limit" | "repeated-call" | "provider";
      message: string;
      cause?: unknown;
    }
  | {
      type: "done";
      reason: "end-turn" | "max-iterations" | "aborted" | "error";
    };

export interface Agent {
  /**
   * Run a full turn (model ↔ tools until the model stops). Resolves with the
   * final assistant message; errors/abort yield a "system-notice" message and
   * still resolve. Throws only on send-while-running.
   */
  send(text: string, opts?: { signal?: AbortSignal }): Promise<AgentMessage>;
  /** Aborts the provider fetch; the loop stops between tool calls. */
  abort(): void;
  /** Clears the conversation (memory only — never persisted). */
  reset(): void;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** Stable-ref snapshot (useSyncExternalStore-ready). */
  getState(): AgentState;
}
