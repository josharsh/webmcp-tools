import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { getRegisteredTools, tool } from "webmcp-kit";
import { createWebMCPServer } from "./server.js";
import type { WebMCPBridgeServer } from "./server.js";
import {
  PostMessageClientTransport,
  PostMessageServerTransport,
} from "./post-message-transport.js";

const ORIGIN = window.location.origin;

type TextContent = Array<{ type: string; text: string }>;

let channelCounter = 0;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  for (const t of getRegisteredTools()) t.unregister();
});

function registerFixtureTools() {
  const echo = tool("echo-upper", {
    description: "Uppercase a string",
    input: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    run: ({ text }) => String(text).toUpperCase(),
  });
  const cart = tool("get-cart", {
    description: "Get cart contents",
    title: "Get cart",
    readOnly: true,
    run: () => ({ items: 2 }),
  });
  return { echo, cart };
}

async function connectPair(): Promise<{
  bridge: WebMCPBridgeServer;
  client: Client;
}> {
  const channel = `test-channel-${channelCounter++}`;
  const bridge = createWebMCPServer({ name: "test-bridge", version: "9.9.9" });
  const serverTransport = new PostMessageServerTransport({
    allowedOrigins: [ORIGIN],
    channel,
  });
  await bridge.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const clientTransport = new PostMessageClientTransport({
    target: window,
    targetOrigin: ORIGIN,
    channel,
  });
  await client.connect(clientTransport);

  cleanups.push(async () => {
    await client.close();
    await bridge.close();
  });
  return { bridge, client };
}

describe("createWebMCPServer over postMessage", () => {
  it("lists registered tools with their schemas", async () => {
    registerFixtureTools();
    const { client } = await connectPair();

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["echo-upper", "get-cart"]);

    const echo = tools.find((t) => t.name === "echo-upper")!;
    expect(echo.description).toBe("Uppercase a string");
    expect(echo.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });

    const cart = tools.find((t) => t.name === "get-cart")!;
    expect(cart.title).toBe("Get cart");
    expect(cart.inputSchema).toEqual({ type: "object", properties: {} });
    expect(cart.annotations).toEqual({ readOnlyHint: true });
  });

  it("executes a tool call and returns its content", async () => {
    registerFixtureTools();
    const { client } = await connectPair();

    const result = await client.callTool({
      name: "echo-upper",
      arguments: { text: "hi there" },
    });
    expect(result.isError).toBeFalsy();
    expect((result.content as TextContent)[0]).toEqual({
      type: "text",
      text: "HI THERE",
    });
  });

  it("returns structuredContent for object results", async () => {
    registerFixtureTools();
    const { client } = await connectPair();

    const result = await client.callTool({ name: "get-cart", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ items: 2 });
  });

  it("rejects invalid arguments with an isError result and validation message", async () => {
    registerFixtureTools();
    const { client } = await connectPair();

    const result = await client.callTool({
      name: "echo-upper",
      arguments: { text: 42 },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0]!.text).toContain(
      'Invalid input for tool "echo-upper"',
    );
  });

  it("rejects unknown tool names with a JSON-RPC InvalidParams error", async () => {
    registerFixtureTools();
    const { client } = await connectPair();

    await expect(client.callTool({ name: "no-such-tool" })).rejects.toThrow(
      /Unknown tool: no-such-tool/,
    );
  });

  it("normalizes a non-object inputSchema so tools/list never breaks", async () => {
    tool("bad-schema", {
      description: "Registered with a non-object schema type",
      input: { type: "string" },
      run: () => "ok",
    });
    registerFixtureTools();
    const { client } = await connectPair();

    const { tools } = await client.listTools();
    const bad = tools.find((t) => t.name === "bad-schema")!;
    expect(bad.inputSchema.type).toBe("object");
    expect(tools).toHaveLength(3); // the bad tool didn't break the list
  });

  it("omits structuredContent for non-plain-object results (arrays)", async () => {
    tool("list-things", {
      description: "Returns an array",
      run: () => [1, 2, 3],
    });
    const { client } = await connectPair();

    const result = await client.callTool({ name: "list-things" });
    expect(result.structuredContent).toBeUndefined();
    expect((result.content as TextContent)[0]!.text).toBe("[1,2,3]");
  });

  it("preserves untrustedContentHint via _meta across listTools", async () => {
    tool("ugc-echo", {
      description: "Echoes user-generated content",
      readOnly: true,
      untrustedContent: true,
      run: () => "ok",
    });
    const { client } = await connectPair();

    const { tools } = await client.listTools();
    const ugc = tools.find((t) => t.name === "ugc-echo")!;
    expect(ugc._meta).toEqual({ "webmcp/untrustedContentHint": true });
    // readOnlyHint survives in annotations (the SDK schema keeps it).
    expect(ugc.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("hides exposedTo tools from peers whose origin is not listed", async () => {
    tool("scoped-tool", {
      description: "Only for allowed.example",
      exposedTo: ["https://allowed.example"],
      run: () => "secret",
    });
    tool("open-tool", { description: "For everyone", run: () => "open" });
    const { client } = await connectPair();

    // The connected peer's origin is ORIGIN, not in the exposedTo list.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["open-tool"]);

    // Hidden tools are indistinguishable from unknown ones for tools/call.
    await expect(client.callTool({ name: "scoped-tool" })).rejects.toThrow(
      /Unknown tool: scoped-tool/,
    );
  });

  it("serves exposedTo tools to peers whose origin is listed", async () => {
    tool("scoped-tool", {
      description: "Exposed to this test's origin",
      exposedTo: [ORIGIN],
      run: () => "visible",
    });
    const { client } = await connectPair();

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["scoped-tool"]);

    const result = await client.callTool({ name: "scoped-tool" });
    expect((result.content as TextContent)[0]!.text).toBe("visible");
  });

  it("sends list_changed on unregister and drops the tool from tools/list", async () => {
    const { cart } = registerFixtureTools();
    const { client } = await connectPair();

    const changed = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        resolve();
      });
    });

    cart.unregister();
    await changed;

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo-upper"]);

    // Calling the unregistered tool is now a JSON-RPC error.
    await expect(client.callTool({ name: "get-cart" })).rejects.toThrow(
      /Unknown tool: get-cart/,
    );
  });

  it("sends list_changed when a tool is registered after connect", async () => {
    registerFixtureTools();
    const { client } = await connectPair();

    const changed = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        resolve();
      });
    });

    tool("late-tool", {
      description: "Registered after the bridge connected",
      run: () => "late",
    });
    await changed;

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("late-tool");
  });

  it("never executes tools for messages from disallowed origins", async () => {
    let executed = false;
    tool("sensitive", {
      description: "Must not run for untrusted callers",
      run: () => {
        executed = true;
        return "ran";
      },
    });

    const channel = `test-channel-${channelCounter++}`;
    const bridge = createWebMCPServer();
    const serverTransport = new PostMessageServerTransport({
      allowedOrigins: ["https://only-this.example"],
      channel,
    });
    await bridge.connect(serverTransport);
    cleanups.push(() => bridge.close());

    const replies: unknown[] = [];
    const replyListener = (event: MessageEvent) => {
      const data = event.data as { channel?: string; side?: string };
      if (data?.channel === channel && data?.side === "server") {
        replies.push(event.data);
      }
    };
    window.addEventListener("message", replyListener);
    cleanups.push(() => window.removeEventListener("message", replyListener));

    // Real postMessage: event.origin is this window's origin, which is NOT
    // in allowedOrigins — the server must stay silent.
    window.postMessage(
      {
        channel,
        side: "client",
        message: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "sensitive", arguments: {} },
        },
      },
      ORIGIN,
    );
    await new Promise((r) => setTimeout(r, 30));

    expect(executed).toBe(false);
    expect(replies).toEqual([]);
  });
});
