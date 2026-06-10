import {
  errorResult,
  getRegisteredTool,
  getRegisteredTools,
  isPonyfill,
  normalizeResult,
  onRegistryChange,
} from "webmcp-tools";
import type {
  ModelContext,
  ModelContextClient,
  ModelContextTool,
  ToolResult,
} from "webmcp-tools";
import type { Json, ProviderToolDescriptor, ToolSource } from "./types.js";

const EMPTY_SCHEMA = { type: "object", properties: {} } as const;

function toDescriptor(
  tool: Omit<ModelContextTool, "execute">,
): ProviderToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { ...EMPTY_SCHEMA },
    ...(tool.title !== undefined && { title: tool.title }),
    ...(tool.annotations !== undefined && { annotations: tool.annotations }),
  };
}

function hostContext(): ModelContext | undefined {
  return typeof document !== "undefined" ? document.modelContext : undefined;
}

/**
 * Default ToolSource: discover and execute the page's WebMCP tools through
 * `document.modelContext` — never by importing app code.
 *
 * Precedence:
 * 1. Kit ponyfill (`isPonyfill`): provisional agent-side `getTools` /
 *    `executeTool`, which sees raw `registerTool` tools too and enforces
 *    `exposedTo`. Raw results are normalized via core conventions.
 * 2. Otherwise (native host — the spec has no enumeration API yet — or no
 *    host): the webmcp-tools registry. Tools registered natively while
 *    bypassing webmcp-tools are invisible on this path (documented).
 *
 * Both paths run core's pipeline (validation → confirm gate → normalization).
 */
export function pageToolSource(opts: { origin?: string } = {}): ToolSource {
  const agentOpts =
    opts.origin !== undefined ? { origin: opts.origin } : undefined;

  return {
    list(): ProviderToolDescriptor[] {
      const ctx = hostContext();
      if (isPonyfill(ctx)) {
        return ctx.getTools(agentOpts).map(toDescriptor);
      }
      return getRegisteredTools()
        .filter((t) => !t.unregistered)
        .map((t) => toDescriptor(t.descriptor));
    },

    async execute(
      name: string,
      input: Json,
      client: ModelContextClient,
    ): Promise<ToolResult> {
      const ctx = hostContext();
      if (isPonyfill(ctx)) {
        try {
          const raw = await ctx.executeTool(name, input, client, agentOpts);
          return normalizeResult(raw);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(message);
        }
      }
      const handle = getRegisteredTool(name);
      if (!handle || handle.unregistered) {
        return errorResult(`No tool named "${name}" is registered`);
      }
      return handle.execute(input, client);
    },

    subscribe(onChange: () => void): () => void {
      const offRegistry = onRegistryChange(() => onChange());
      const ctx = hostContext();
      if (ctx && typeof ctx.addEventListener === "function") {
        const handler = () => onChange();
        ctx.addEventListener("toolchange", handler);
        return () => {
          offRegistry();
          ctx.removeEventListener("toolchange", handler);
        };
      }
      return offRegistry;
    },
  };
}
