import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../types.js";
import type { ProviderChatRequest, ProviderEvent } from "../types.js";
import { anthropic, proxy } from "./anthropic.js";

function makeRequest(): ProviderChatRequest {
  return {
    system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      {
        name: "add-to-cart",
        description: "Add to cart [mutates page state]",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    maxTokens: 1234,
    signal: new AbortController().signal,
  };
}

function minimalStream(): ReadableStream<Uint8Array> {
  const sse = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const text =
    sse("message_start", { type: "message_start", message: {} }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    }) +
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    }) +
    sse("message_stop", { type: "message_stop" });
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function stubFetch() {
  const mock = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, body: minimalStream() }),
    );
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function drain(iterable: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("anthropic() browser safety", () => {
  it("THROWS in a window context with an apiKey but no dangerouslyAllowBrowser", () => {
    expect(typeof window).toBe("object"); // happy-dom
    expect(() => anthropic({ apiKey: "sk-ant-test" })).toThrow(
      /dangerouslyAllowBrowser/,
    );
  });

  it("warns once (and only once) with dangerouslyAllowBrowser", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    anthropic({ apiKey: "sk-ant-test", dangerouslyAllowBrowser: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("proxy(");
    anthropic({ apiKey: "sk-ant-test", dangerouslyAllowBrowser: true });
    // No additional warning for the second construction (module-level once).
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not throw without an apiKey (proxy-style usage)", () => {
    expect(() => anthropic()).not.toThrow();
  });
});

describe("anthropic() wire headers and body", () => {
  it("sends x-api-key + dangerous-browser header ONLY with an apiKey, model pinned", async () => {
    const mock = stubFetch();
    const provider = anthropic({
      apiKey: "sk-ant-key-1",
      dangerouslyAllowBrowser: true,
    });
    await drain(provider.chat(makeRequest()));

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-key-1");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(1234);
    expect(typeof body.model).toBe("string");
    expect(body.tools).toEqual([
      {
        name: "add-to-cart",
        description: "Add to cart [mutates page state]",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("proxy() sends neither key nor dangerous header, omits model unless given", async () => {
    const mock = stubFetch();
    const provider = proxy({ url: "https://example.com/api/agent" });
    await drain(provider.chat(makeRequest()));

    const [url, init] = mock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://example.com/api/agent/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeUndefined();
    expect(
      headers["anthropic-dangerous-direct-browser-access"],
    ).toBeUndefined();
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect("model" in body).toBe(false);

    // With an explicit model, it is forwarded.
    const provider2 = proxy({
      url: "https://example.com/api/agent",
      model: "claude-x",
    });
    await drain(provider2.chat(makeRequest()));
    const init2 = mock.mock.calls[1]![1] as RequestInit;
    expect(
      (JSON.parse(String(init2.body)) as Record<string, unknown>).model,
    ).toBe("claude-x");
  });

  it("never leaks the apiKey in error messages (HTTP error echoing the key)", async () => {
    const key = "sk-ant-secret-abc123";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => `invalid x-api-key: ${key}`,
      }),
    );
    const provider = anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    let caught: unknown;
    try {
      await drain(provider.chat(makeRequest()));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const message = (caught as Error).message;
    expect(message).not.toContain(key);
    expect(message).toContain("[redacted]");
  });

  it("never leaks the apiKey when fetch itself rejects", async () => {
    const key = "sk-ant-secret-xyz";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`connect failed for key ${key}`)),
    );
    const provider = anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    let caught: unknown;
    try {
      await drain(provider.chat(makeRequest()));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as Error).message).not.toContain(key);
  });
});
