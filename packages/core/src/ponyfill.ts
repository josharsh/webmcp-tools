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
 * empty name/description, non-object inputSchema; `toolchange` fires on
 * register/unregister; AbortSignal unregisters.
 */

export interface PonyfillModelContext extends ModelContext {
  /** Provisional agent-side API (spec TODO): list registered tools. */
  getTools(): Array<Omit<ModelContextTool, "execute">>;
  /** Provisional agent-side API (spec TODO): invoke a tool by name. */
  executeTool(
    name: string,
    input: Record<string, unknown>,
    client?: ModelContextClient,
  ): Promise<unknown>;
  /** Marker so feature detection can distinguish ponyfill from native. */
  __webmcpKitPonyfill: true;
}

const defaultClient: ModelContextClient = {
  requestUserInteraction: async (callback) => callback(),
};

class ModelContextPonyfill extends EventTarget implements ModelContext {
  __webmcpKitPonyfill = true as const;
  ontoolchange: ((this: ModelContext, ev: Event) => unknown) | null = null;

  #tools = new Map<string, ModelContextTool>();

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
        new TypeError("registerTool: tool name must be a non-empty string"),
      );
    }
    if (
      typeof toolDef.description !== "string" ||
      toolDef.description.length === 0
    ) {
      return Promise.reject(
        new TypeError(
          "registerTool: tool description must be a non-empty string",
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
    if (this.#tools.has(toolDef.name)) {
      return Promise.reject(
        new DOMException(
          `A tool named "${toolDef.name}" is already registered`,
          "InvalidStateError",
        ),
      );
    }
    if (options.signal?.aborted) return Promise.resolve();

    this.#tools.set(toolDef.name, toolDef);
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

  getTools(): Array<Omit<ModelContextTool, "execute">> {
    return [...this.#tools.values()].map(({ execute: _execute, ...rest }) => ({
      ...rest,
    }));
  }

  async executeTool(
    name: string,
    input: Record<string, unknown>,
    client: ModelContextClient = defaultClient,
  ): Promise<unknown> {
    const toolDef = this.#tools.get(name);
    if (!toolDef) {
      throw new DOMException(
        `No tool named "${name}" is registered`,
        "NotFoundError",
      );
    }
    return toolDef.execute(input ?? {}, client);
  }

  #emitToolChange(): void {
    const event = new Event("toolchange");
    this.dispatchEvent(event);
    this.ontoolchange?.call(this, event);
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
  const instance = new ModelContextPonyfill();
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
