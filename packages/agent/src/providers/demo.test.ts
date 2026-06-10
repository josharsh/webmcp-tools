import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  ProviderChatRequest,
  ProviderEvent,
  ProviderToolDescriptor,
} from "../types.js";
import { demo } from "./demo.js";

function makeRequest(
  messages: ChatMessage[],
  tools: ProviderToolDescriptor[] = [],
): ProviderChatRequest {
  return {
    system: "",
    messages,
    tools,
    maxTokens: 4096,
    signal: new AbortController().signal,
  };
}

function user(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

async function collect(iterable: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function textOf(events: ProviderEvent[]): string {
  return events
    .filter((e) => e.type === "text-delta")
    .map((e) => (e as { text: string }).text)
    .join("");
}

const cartTool: ProviderToolDescriptor = {
  name: "add-to-cart",
  title: "Add to cart",
  description: "Add a product to the shopping cart",
  inputSchema: {
    type: "object",
    properties: { sku: { type: "string" }, qty: { type: "number" } },
  },
};

const themeTool: ProviderToolDescriptor = {
  name: "set-theme",
  title: "Set theme",
  description: "Switch the page color theme",
  inputSchema: {
    type: "object",
    properties: { theme: { enum: ["light", "dark"] } },
  },
};

const searchTool: ProviderToolDescriptor = {
  name: "search-products",
  title: "Search products",
  description: "Search the product catalog",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
  },
};

describe("demo() provider", () => {
  it("is deterministic: same input, same events", async () => {
    const request = () =>
      makeRequest([user("add 2 to the cart")], [cartTool, themeTool]);
    const a = await collect(demo().chat(request()));
    const b = await collect(demo().chat(request()));
    expect(a).toEqual(b);
  });

  it("picks the right tool by keyword score", async () => {
    const events = await collect(
      demo().chat(
        makeRequest(
          [user("switch the theme to dark please")],
          [cartTool, themeTool, searchTool],
        ),
      ),
    );
    const call = events.find((e) => e.type === "tool-call")!;
    expect(call).toMatchObject({ name: "set-theme", input: { theme: "dark" } });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool-use" });
  });

  it("extracts enum, number, and quoted-span inputs from the schema", async () => {
    const tool: ProviderToolDescriptor = {
      name: "order-item",
      title: "Order item",
      description: "Order an item from the store",
      inputSchema: {
        type: "object",
        properties: {
          size: { enum: ["small", "large"] },
          qty: { type: "integer" },
          note: { type: "string" },
        },
      },
    };
    const events = await collect(
      demo().chat(
        makeRequest(
          [user('order a large one, qty 4, note "leave at door"')],
          [tool],
        ),
      ),
    );
    const call = events.find((e) => e.type === "tool-call")!;
    expect(call).toMatchObject({
      name: "order-item",
      input: { size: "large", qty: 4, note: "leave at door" },
    });
  });

  it("scripted rules: first matching rule wins, in order", async () => {
    const provider = demo({
      script: [
        { match: "cart", reply: "first rule" },
        {
          match: /cart/i,
          reply: "second rule",
          toolCalls: [{ name: "add-to-cart", input: { sku: "x" } }],
        },
      ],
    });
    const events = await collect(
      provider.chat(makeRequest([user("look at my CART")], [cartTool])),
    );
    expect(textOf(events)).toBe("first rule");
    expect(events.some((e) => e.type === "tool-call")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end-turn" });
  });

  it("scripted tool calls are emitted after the reply, then done(tool-use)", async () => {
    const provider = demo({
      script: [
        {
          match: "buy",
          reply: "Adding that for you now",
          toolCalls: [{ name: "add-to-cart", input: { sku: "s1", qty: 1 } }],
        },
      ],
    });
    const events = await collect(
      provider.chat(makeRequest([user("buy it")], [cartTool])),
    );
    const types = events.map((e) => e.type);
    expect(types.indexOf("tool-call")).toBeGreaterThan(
      types.lastIndexOf("text-delta"),
    );
    expect(events.find((e) => e.type === "tool-call")).toMatchObject({
      name: "add-to-cart",
      input: { sku: "s1", qty: 1 },
    });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool-use" });
  });

  it("streams replies as multiple chunked text deltas", async () => {
    const events = await collect(
      demo().chat(makeRequest([user("hello there")], [])),
    );
    const deltas = events.filter((e) => e.type === "text-delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
  });

  it("greets and lists discovered tools when nothing matches", async () => {
    const events = await collect(
      demo().chat(makeRequest([user("zzz qqq")], [cartTool, themeTool])),
    );
    const text = textOf(events);
    expect(text).toContain("not AI");
    expect(text).toContain("2 tools");
    expect(text).toContain("Add to cart");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end-turn" });
  });

  it("summarizes tool results on the second iteration (real loop shape)", async () => {
    const messages: ChatMessage[] = [
      user("add to cart"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          {
            type: "tool_use",
            id: "demo-call-1",
            name: "add-to-cart",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "demo-call-1",
            content: '{"ok":true,"cartSize":3}',
          },
        ],
      },
    ];
    const events = await collect(
      demo().chat(makeRequest(messages, [cartTool])),
    );
    const text = textOf(events);
    expect(text).toContain("add-to-cart");
    expect(text).toContain("cartSize");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end-turn" });
  });

  it("marks failed tool results as failures in the summary", async () => {
    const messages: ChatMessage[] = [
      user("add to cart"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "demo-call-1",
            name: "add-to-cart",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "demo-call-1",
            content: "Out of stock",
            isError: true,
          },
        ],
      },
    ];
    const events = await collect(
      demo().chat(makeRequest(messages, [cartTool])),
    );
    expect(textOf(events)).toContain("failed");
  });

  it("is labeled as scripted, not AI", () => {
    const provider = demo();
    expect(provider.kind).toBe("scripted");
    expect(provider.label).toBe("Demo (scripted — not AI)");
  });
});
