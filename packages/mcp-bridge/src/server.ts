import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getRegisteredTools, onRegistryChange } from "webmcp-kit";
import type { RegisteredTool } from "webmcp-kit";

export interface CreateWebMCPServerOptions {
  /** MCP server name advertised during initialize. Default: "webmcp-kit". */
  name?: string;
  /** MCP server version advertised during initialize. Default: "0.1.0". */
  version?: string;
}

export interface WebMCPBridgeServer {
  /** The underlying low-level MCP `Server` (for custom handlers/notifications). */
  server: Server;
  /** Connect to a transport (e.g. `PostMessageServerTransport`). */
  connect(transport: Transport): Promise<void>;
  /** Disconnect and stop forwarding registry changes. */
  close(): Promise<void>;
}

function toMcpTool(registered: RegisteredTool): Tool {
  const { descriptor } = registered;
  // MCP `Tool.inputSchema` REQUIRES type: "object". Normalize descriptors
  // that are missing a schema or use a different type so one bad tool can
  // never break tools/list.
  const original = descriptor.inputSchema;
  const inputSchema = {
    properties: {},
    ...(original ?? {}),
    type: "object",
  } as Tool["inputSchema"];
  // The SDK's annotations schema strips `untrustedContentHint` (it's a WebMCP
  // extension); preserve it in `_meta`, which the SDK passes through.
  const untrusted = descriptor.annotations?.untrustedContentHint;
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema,
    ...(descriptor.title !== undefined && { title: descriptor.title }),
    ...(descriptor.annotations !== undefined && {
      annotations: descriptor.annotations,
    }),
    ...(untrusted !== undefined && {
      _meta: { "webmcp/untrustedContentHint": untrusted },
    }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Create an MCP server backed by the webmcp-kit registry.
 *
 * `tools/list` reflects `getRegisteredTools()` (filtered by each tool's
 * `exposedTo` against the transport's bound peer origin), `tools/call` runs
 * the tool's full pipeline (validation, confirm gate, normalization) via
 * `RegisteredTool.execute`, and registry changes are forwarded as
 * `notifications/tools/list_changed`.
 */
export function createWebMCPServer(
  opts: CreateWebMCPServerOptions = {},
): WebMCPBridgeServer {
  const server = new Server(
    {
      name: opts.name ?? "webmcp-kit",
      version: opts.version ?? "0.1.0",
    },
    {
      capabilities: { tools: { listChanged: true } },
    },
  );

  // Set on connect when the transport exposes a `peerOrigin` getter (e.g.
  // PostMessageServerTransport). Read lazily — the peer binds on its first
  // valid message, after connect() returns.
  let readPeerOrigin: (() => string | undefined) | undefined;

  function visibleTools(): RegisteredTool[] {
    const peerOrigin = readPeerOrigin?.();
    return getRegisteredTools().filter(
      (t) =>
        t.exposedTo === undefined ||
        (peerOrigin !== undefined && t.exposedTo.includes(peerOrigin)),
    );
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools().map(toMcpTool),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const tool = visibleTools().find((t) => t.name === request.params.name);
      // Tools hidden from this peer are indistinguishable from unknown ones.
      if (!tool) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown tool: ${request.params.name}`,
        );
      }
      const result = await tool.execute(request.params.arguments ?? {});
      return {
        content: result.content,
        ...(result.isError !== undefined && { isError: result.isError }),
        // structuredContent must be a plain object per MCP; the text block
        // already carries the JSON for anything else.
        ...(isPlainObject(result.structuredContent) && {
          structuredContent: result.structuredContent,
        }),
      };
    },
  );

  let connected = false;
  const unsubscribe = onRegistryChange(() => {
    if (!connected) return;
    server.sendToolListChanged().catch((err) => {
      // Peer may have disconnected between the change and the send; the
      // next tools/list will be correct regardless.
      console.error("@webmcp-kit/mcp-bridge: list_changed failed", err);
    });
  });

  return {
    server,
    async connect(transport: Transport): Promise<void> {
      if ("peerOrigin" in transport) {
        const t = transport as Transport & { peerOrigin: string | undefined };
        readPeerOrigin = () => t.peerOrigin;
      } else {
        readPeerOrigin = undefined;
      }
      await server.connect(transport);
      connected = true;
    },
    async close(): Promise<void> {
      unsubscribe();
      connected = false;
      readPeerOrigin = undefined;
      await server.close();
    },
  };
}
