/**
 * Types for webmcp-kit.
 *
 * The `ModelContext*` types mirror the WebMCP spec draft
 * (https://webmachinelearning.github.io/webmcp/) so the kit composes with
 * native implementations (Chrome 149+ origin trial) and with our ponyfill.
 */

// ---------------------------------------------------------------------------
// Standard Schema (https://standardschema.dev) — vendored interface.
// The spec is designed to be copied into libraries to avoid a dependency.
// Implemented by Zod 3.24+/4, Valibot 1+, ArkType 2+, and others.
// ---------------------------------------------------------------------------

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  export type InferInput<S extends StandardSchemaV1> = NonNullable<
    S["~standard"]["types"]
  >["input"];

  export type InferOutput<S extends StandardSchemaV1> = NonNullable<
    S["~standard"]["types"]
  >["output"];
}

// ---------------------------------------------------------------------------
// WebMCP spec surface (document.modelContext)
// ---------------------------------------------------------------------------

/** JSON Schema object (the subset WebMCP descriptors use). */
export type JsonSchema = Record<string, unknown>;

/** MCP-style content block returned to the agent. */
export interface ToolContentBlock {
  type: "text";
  text: string;
}

/** Normalized tool result, matching MCP `CallToolResult` conventions. */
export interface ToolResult {
  content: ToolContentBlock[];
  isError?: boolean;
  /** Structured payload for agents that understand it (MCP structuredContent). */
  structuredContent?: unknown;
}

/** `ModelContextClient` per spec — handed to `execute` by the browser. */
export interface ModelContextClient {
  requestUserInteraction<T>(callback: () => Promise<T> | T): Promise<T>;
}

/** `ToolAnnotations` dictionary per spec. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

/** `ModelContextTool` dictionary per spec. */
export interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: JsonSchema;
  execute: (
    input: Record<string, unknown>,
    client: ModelContextClient,
  ) => unknown | Promise<unknown>;
  annotations?: ToolAnnotations;
}

/** `ModelContextRegisterToolOptions` dictionary per spec. */
export interface ModelContextRegisterToolOptions {
  signal?: AbortSignal;
  exposedTo?: string[];
}

/** The `document.modelContext` interface per spec. */
export interface ModelContext extends EventTarget {
  registerTool(
    tool: ModelContextTool,
    options?: ModelContextRegisterToolOptions,
  ): Promise<void>;
  ontoolchange: ((this: ModelContext, ev: Event) => unknown) | null;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
}

// ---------------------------------------------------------------------------
// webmcp-kit public API types
// ---------------------------------------------------------------------------

/** Input definition: a Standard Schema (Zod/Valibot/ArkType) or raw JSON Schema. */
export type ToolInput = StandardSchemaV1 | JsonSchema;

/** Infer the validated argument type a tool's `run` receives. */
export type InferToolArgs<I extends ToolInput | undefined> =
  I extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<I>
    : Record<string, unknown>;

export interface ToolContext {
  /**
   * Ask the user to confirm/interact mid-execution. Routed through the
   * native `ModelContextClient.requestUserInteraction` when available so the
   * browser can suspend the agent loop; falls back to invoking the callback
   * directly otherwise.
   */
  requestUserInteraction<T>(callback: () => Promise<T> | T): Promise<T>;
  /** The raw (pre-validation) input the agent sent. */
  rawInput: Record<string, unknown>;
  /** AbortSignal that fires if the tool is unregistered mid-flight. */
  signal: AbortSignal;
}

export type ConfirmOption<Args> =
  | boolean
  | string
  | ((args: Args) => boolean | string | Promise<boolean | string>);

export interface ToolDefinition<I extends ToolInput | undefined = undefined> {
  /** Natural-language description the agent uses to decide when to call. */
  description: string;
  /** Display title (optional, per spec `ModelContextTool.title`). */
  title?: string;
  /** Standard Schema (Zod v4/Valibot/ArkType) or raw JSON Schema object. */
  input?: I;
  /**
   * Explicit JSON Schema for the descriptor. Required only when `input` is a
   * Standard Schema from a vendor with no registered converter.
   */
  inputJsonSchema?: JsonSchema;
  /** The implementation. Receives validated, typed args. */
  run: (args: InferToolArgs<I>, ctx: ToolContext) => unknown | Promise<unknown>;
  /**
   * Human-in-the-loop gate evaluated before `run`:
   * - `true` → confirm with a generated message
   * - string → confirm with that message
   * - function → return `false`/`true` to allow silently, or a string to
   *   confirm with that message; returning `false` from the *handler* denies.
   */
  confirm?: ConfirmOption<InferToolArgs<I>>;
  /** Spec `ToolAnnotations`. `readOnly: true` sets `readOnlyHint`. */
  readOnly?: boolean;
  untrustedContent?: boolean;
  /** Spec registration options. */
  exposedTo?: string[];
  signal?: AbortSignal;
}

export interface RegisteredTool {
  name: string;
  /** The exact descriptor handed to `registerTool` (minus `execute`). */
  descriptor: Omit<ModelContextTool, "execute">;
  /** Resolves when native registration completed (or ponyfill registration). */
  ready: Promise<void>;
  /** Unregister the tool (aborts the underlying registration signal). */
  unregister(): void;
  /** True once `unregister` was called or the provided signal aborted. */
  readonly unregistered: boolean;
  /**
   * Invoke the tool locally exactly as an agent would (validation, confirm
   * gate, result normalization included). Useful for tests and for bridges.
   */
  execute(
    input: Record<string, unknown>,
    client?: ModelContextClient,
  ): Promise<ToolResult>;
}

/** How the user is asked to confirm when no native client is available. */
export type ConfirmHandler = (
  message: string,
  toolName: string,
  args: unknown,
) => boolean | Promise<boolean>;

export interface WebMCPKitConfig {
  /**
   * Used by `confirm` gates. Default: `window.confirm(message)` when a DOM is
   * present, otherwise auto-deny (safe default for non-interactive contexts).
   */
  confirmHandler?: ConfirmHandler;
  /**
   * When `document.modelContext` is missing:
   * - "ponyfill" (default): install the kit ponyfill so extension/iframe
   *   agents and the MCP bridge can still discover & call tools
   * - "noop": registrations succeed silently but go nowhere
   * - "throw": registration rejects
   */
  missingHost?: "ponyfill" | "noop" | "throw";
}

export type RegistryEvent =
  | { type: "register"; tool: RegisteredTool }
  | { type: "unregister"; tool: RegisteredTool };

export type RegistryListener = (event: RegistryEvent) => void;
