import type {
  ModelContext,
  ModelContextClient,
  ModelContextRegisterToolOptions,
  ModelContextTool,
} from "./types.js";

/**
 * Spec-compliant ponyfill of `document.modelContext`.
 *
 * Browsers without WebMCP get a working host so that:
 *  - page code using `tool()` behaves identically everywhere
 *  - author-provided agents (iframes, extensions, the MCP bridge) can
 *    discover and invoke tools via `getTools()` / `executeTool()` — the
 *    agent-side surface the spec lists as TODO, implemented here with the
 *    obvious shape so bridges have something real to talk to.
 *
 * Registration semantics follow the spec draft: rejects on duplicate names,
 * empty/invalid name, empty description (InvalidStateError), non-object
 * inputSchema (TypeError); `toolchange` fires asynchronously on
 * register/unregister; AbortSignal unregisters; `exposedTo` origins are
 * validated at registration and enforced on `getTools` / `executeTool`.
 */

/** Caller-context options for the provisional agent-side surface. */
export interface PonyfillAgentOptions {
  /**
   * Origin of the calling agent context. Omitted means the caller is treated
   * as same-origin (e.g. an in-page dev panel), which can see every tool.
   */
  origin?: string;
}

export interface PonyfillModelContext extends ModelContext {
  /** Provisional agent-side API (spec TODO): list tools visible to `opts.origin`. */
  getTools(
    opts?: PonyfillAgentOptions,
  ): Array<Omit<ModelContextTool, "execute">>;
  /** Provisional agent-side API (spec TODO): invoke a tool by name. */
  executeTool(
    name: string,
    input: Record<string, unknown>,
    client?: ModelContextClient,
    opts?: PonyfillAgentOptions,
  ): Promise<unknown>;
  /** Marker so feature detection can distinguish ponyfill from native. */
  __webmcpKitPonyfill: true;
}

const defaultClient: ModelContextClient = {
  requestUserInteraction: async (callback) => callback(),
};

/** Spec constraint: 1–128 chars from [A-Za-z0-9_.-]. */
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * An `exposedTo` entry must be a serialized origin that is potentially
 * trustworthy: https, or http on localhost/127.0.0.1.
 */
function validateExposedOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value) return null;
  const trustworthy =
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  return trustworthy ? value : null;
}

interface ToolEntry {
  tool: ModelContextTool;
  exposedTo?: string[];
}

class ModelContextPonyfill extends EventTarget implements ModelContext {
  __webmcpKitPonyfill = true as const;
  ontoolchange: ((this: ModelContext, ev: Event) => unknown) | null = null;

  #tools = new Map<string, ToolEntry>();
  #doc: Document;

  constructor(doc: Document) {
    super();
    this.#doc = doc;
  }

  registerTool(
    toolDef: ModelContextTool,
    options: ModelContextRegisterToolOptions = {},
  ): Promise<void> {
    if (!toolDef || typeof toolDef !== "object") {
      return Promise.reject(
        new TypeError("registerTool: tool must be an object"),
      );
    }
    if (typeof toolDef.name !== "string" || toolDef.name.length === 0) {
      return Promise.reject(
        new DOMException(
          "registerTool: tool name must be a non-empty string",
          "InvalidStateError",
        ),
      );
    }
    if (!TOOL_NAME_RE.test(toolDef.name)) {
      return Promise.reject(
        new DOMException(
          `registerTool: invalid tool name ${JSON.stringify(toolDef.name)} — ` +
            "names must be 1-128 characters from [A-Za-z0-9_.-]",
          "InvalidStateError",
        ),
      );
    }
    if (
      typeof toolDef.description !== "string" ||
      toolDef.description.length === 0
    ) {
      return Promise.reject(
        new DOMException(
          "registerTool: tool description must be a non-empty string",
          "InvalidStateError",
        ),
      );
    }
    if (typeof toolDef.execute !== "function") {
      return Promise.reject(
        new TypeError("registerTool: tool execute must be a function"),
      );
    }
    if (
      toolDef.inputSchema !== undefined &&
      (typeof toolDef.inputSchema !== "object" || toolDef.inputSchema === null)
    ) {
      return Promise.reject(
        new TypeError("registerTool: inputSchema must be an object"),
      );
    }
    let exposedTo: string[] | undefined;
    if (options.exposedTo !== undefined) {
      exposedTo = [];
      for (const entry of options.exposedTo) {
        const origin = validateExposedOrigin(entry);
        if (origin === null) {
          return Promise.reject(
            new DOMException(
              `registerTool: exposedTo entry ${JSON.stringify(entry)} is not ` +
                "a potentially trustworthy origin (https, or http on " +
                "localhost/127.0.0.1)",
              "SecurityError",
            ),
          );
        }
        exposedTo.push(origin);
      }
    }
    if (this.#tools.has(toolDef.name)) {
      return Promise.reject(
        new DOMException(
          `A tool named "${toolDef.name}" is already registered`,
          "InvalidStateError",
        ),
      );
    }
    if (options.signal?.aborted) return Promise.resolve();

    this.#tools.set(toolDef.name, {
      tool: toolDef,
      ...(exposedTo && { exposedTo }),
    });
    options.signal?.addEventListener(
      "abort",
      () => {
        if (this.#tools.delete(toolDef.name)) this.#emitToolChange();
      },
      { once: true },
    );
    this.#emitToolChange();
    return Promise.resolve();
  }

  /**
   * Visibility per spec defaults: no `exposedTo` → visible to any caller;
   * with `exposedTo` → visible to same-origin callers and listed origins.
   */
  #visibleTo(entry: ToolEntry, callerOrigin: string | undefined): boolean {
    if (entry.exposedTo === undefined) return true;
    if (callerOrigin === undefined) return true; // same-origin caller
    if (callerOrigin === this.#doc.location?.origin) return true;
    return entry.exposedTo.includes(callerOrigin);
  }

  getTools(
    opts: PonyfillAgentOptions = {},
  ): Array<Omit<ModelContextTool, "execute">> {
    return [...this.#tools.values()]
      .filter((entry) => this.#visibleTo(entry, opts.origin))
      .map(({ tool: { execute: _execute, ...rest } }) => ({ ...rest }));
  }

  async executeTool(
    name: string,
    input: Record<string, unknown>,
    client: ModelContextClient = defaultClient,
    opts: PonyfillAgentOptions = {},
  ): Promise<unknown> {
    const entry = this.#tools.get(name);
    // Non-visible tools behave exactly like missing ones (don't leak existence).
    if (!entry || !this.#visibleTo(entry, opts.origin)) {
      throw new DOMException(
        `No tool named "${name}" is registered`,
        "NotFoundError",
      );
    }
    return entry.tool.execute(input ?? {}, client);
  }

  #emitToolChange(): void {
    // Per spec, toolchange fires from a queued task — never synchronously
    // inside registerTool/unregister.
    queueMicrotask(() => {
      const event = new Event("toolchange");
      this.dispatchEvent(event);
      this.ontoolchange?.call(this, event);
    });
  }
}

/**
 * Install the ponyfill on `doc` when no native implementation exists.
 * Returns the active ModelContext either way. Idempotent.
 */
export function installPonyfill(
  doc: Document = document,
): PonyfillModelContext | ModelContext {
  if (doc.modelContext) return doc.modelContext;
  const instance = new ModelContextPonyfill(doc);
  Object.defineProperty(doc, "modelContext", {
    value: instance,
    configurable: true, // allow a later native implementation to take over
    enumerable: true,
    writable: false,
  });
  return instance;
}

/** Type guard for hosts that expose the provisional agent-side surface. */
export function isPonyfill(
  ctx: ModelContext | undefined | null,
): ctx is PonyfillModelContext {
  return Boolean(
    ctx && (ctx as PonyfillModelContext).__webmcpKitPonyfill === true,
  );
}
