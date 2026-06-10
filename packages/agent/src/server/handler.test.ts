// @vitest-environment node
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentHandler, nextAppRoute, toNodeHandler } from "./handler.js";
import type { AgentHandlerOptions } from "./handler.js";

const API_KEY = "sk-ant-test-secret-key-123";
const MODEL = "claude-sonnet-4-5-20250929";
const SELF = "http://localhost:3000";
const ROUTE = `${SELF}/api/agent`;

const SSE_CHUNKS = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function sseUpstream(chunks: string[] = SSE_CHUNKS): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function stubUpstream(response: () => Response | Promise<Response>) {
  const mock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) => response(),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function makeHandler(overrides: Partial<AgentHandlerOptions> = {}) {
  return createAgentHandler({ apiKey: API_KEY, model: MODEL, ...overrides });
}

function jsonRequest(
  body: unknown,
  init: {
    origin?: string | null;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...init.headers,
  };
  if (init.origin !== null) headers.origin = init.origin ?? SELF;
  return new Request(init.url ?? ROUTE, {
    method: init.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  max_tokens: 4096,
  stream: true,
  system: "sys",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

async function readChunks(response: Response): Promise<Uint8Array[]> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

const savedEnvKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedEnvKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedEnvKey;
});

describe("createAgentHandler construction", () => {
  it("throws when no apiKey is passed and ANTHROPIC_API_KEY is unset", () => {
    expect(() => createAgentHandler({ model: MODEL })).toThrow(/API key/);
  });

  it("falls back to ANTHROPIC_API_KEY from the environment", () => {
    process.env.ANTHROPIC_API_KEY = API_KEY;
    expect(() => createAgentHandler({ model: MODEL })).not.toThrow();
  });

  it("throws when model is missing (plain-JS callers)", () => {
    expect(() =>
      createAgentHandler({ apiKey: API_KEY } as unknown as AgentHandlerOptions),
    ).toThrow(/model/);
  });
});

describe("happy path streaming", () => {
  it("streams upstream SSE bytes through without buffering", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler();

    const response = await handler(jsonRequest(VALID_BODY));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const chunks = await readChunks(response);
    // Chunk boundaries preserved — proves passthrough, not full buffering.
    expect(chunks).toHaveLength(SSE_CHUNKS.length);
    const decoder = new TextDecoder();
    expect(chunks.map((c) => decoder.decode(c)).join("")).toBe(
      SSE_CHUNKS.join(""),
    );
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("forwards to {baseURL}/v1/messages with the server key and version", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler({ baseURL: "https://example.com/anthropic/" });

    await handler(jsonRequest(VALID_BODY));
    const [url, init] = upstream.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://example.com/anthropic/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(API_KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("injects the pinned model when the client omits it", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler();

    await handler(jsonRequest(VALID_BODY)); // no model field
    const init = upstream.mock.calls[0]![1] as unknown as RequestInit;
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.model).toBe(MODEL);
    expect(sent.messages).toEqual(VALID_BODY.messages);
    expect(sent.stream).toBe(true);
  });

  it("accepts a client model equal to the pin", async () => {
    stubUpstream(() => sseUpstream());
    const handler = makeHandler();
    const response = await handler(
      jsonRequest({ ...VALID_BODY, model: MODEL }),
    );
    expect(response.status).toBe(200);
  });

  it("never exposes the API key in the response", async () => {
    stubUpstream(() => sseUpstream());
    const handler = makeHandler();
    const response = await handler(jsonRequest(VALID_BODY));
    const headerDump = JSON.stringify([...response.headers.entries()]);
    expect(headerDump).not.toContain(API_KEY);
    const text = new TextDecoder().decode(
      (await readChunks(response)).reduce(
        (acc, c) => new Uint8Array([...acc, ...c]),
        new Uint8Array(),
      ),
    );
    expect(text).not.toContain(API_KEY);
  });
});

describe("origin policy", () => {
  it("rejects a missing Origin under the same-origin default", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler();
    const response = await handler(jsonRequest(VALID_BODY, { origin: null }));
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a mismatched Origin under the same-origin default", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler();
    const response = await handler(
      jsonRequest(VALID_BODY, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("accepts the request's own origin under same-origin", async () => {
    stubUpstream(() => sseUpstream());
    const handler = makeHandler();
    const response = await handler(jsonRequest(VALID_BODY, { origin: SELF }));
    expect(response.status).toBe(200);
  });

  it("enforces an explicit allowlist (trailing slashes tolerated)", async () => {
    stubUpstream(() => sseUpstream());
    const handler = makeHandler({
      allowedOrigins: ["https://app.example.com/"],
    });
    const ok = await handler(
      jsonRequest(VALID_BODY, { origin: "https://app.example.com" }),
    );
    expect(ok.status).toBe(200);
    const bad = await handler(
      jsonRequest(VALID_BODY, { origin: "https://other.example.com" }),
    );
    expect(bad.status).toBe(403);
  });

  it('"any" skips the check entirely (no Origin needed)', async () => {
    stubUpstream(() => sseUpstream());
    const handler = makeHandler({ allowedOrigins: "any" });
    const response = await handler(jsonRequest(VALID_BODY, { origin: null }));
    expect(response.status).toBe(200);
  });
});

describe("request validation", () => {
  it("rejects non-POST with 405", async () => {
    const handler = makeHandler();
    const response = await handler(
      new Request(ROUTE, { method: "GET", headers: { origin: SELF } }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects non-JSON content types with 415", async () => {
    const handler = makeHandler();
    const response = await handler(
      new Request(ROUTE, {
        method: "POST",
        headers: { origin: SELF, "content-type": "text/plain" },
        body: "hello",
      }),
    );
    expect(response.status).toBe(415);
  });

  it("rejects an oversized body with 413 (actual size)", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler({ maxBodyBytes: 64 });
    const response = await handler(
      jsonRequest({ ...VALID_BODY, padding: "x".repeat(200) }),
    );
    expect(response.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared Content-Length with 413", async () => {
    const handler = makeHandler({ maxBodyBytes: 64 });
    const response = await handler(
      jsonRequest(VALID_BODY, { headers: { "content-length": "9999999" } }),
    );
    expect(response.status).toBe(413);
  });

  it("rejects malformed JSON with 400", async () => {
    const handler = makeHandler();
    const response = await handler(
      new Request(ROUTE, {
        method: "POST",
        headers: { origin: SELF, "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a model mismatch with 400", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler();
    const response = await handler(
      jsonRequest({ ...VALID_BODY, model: "claude-opus-4-6" }),
    );
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    const body = (await response.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("model_not_allowed");
  });
});

describe("max_tokens clamp", () => {
  it("clamps an excessive client max_tokens to the server cap", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler({ maxTokens: 1024 });
    await handler(jsonRequest({ ...VALID_BODY, max_tokens: 999999 }));
    const init = upstream.mock.calls[0]![1] as unknown as RequestInit;
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.max_tokens).toBe(1024);
  });

  it("injects the cap when max_tokens is missing or invalid", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler();
    const { max_tokens: _omit, ...withoutMaxTokens } = VALID_BODY;
    await handler(jsonRequest({ ...withoutMaxTokens, max_tokens: -5 }));
    const init = upstream.mock.calls[0]![1] as unknown as RequestInit;
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.max_tokens).toBe(4096);
  });

  it("leaves a smaller client max_tokens alone", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler();
    await handler(jsonRequest({ ...VALID_BODY, max_tokens: 256 }));
    const init = upstream.mock.calls[0]![1] as unknown as RequestInit;
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.max_tokens).toBe(256);
  });
});

describe("hooks", () => {
  it("returns 429 when rateLimit denies", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler({ rateLimit: async () => false });
    const response = await handler(jsonRequest(VALID_BODY));
    expect(response.status).toBe(429);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("lets rateLimit allow requests through", async () => {
    stubUpstream(() => sseUpstream());
    const handler = makeHandler({ rateLimit: () => true });
    const response = await handler(jsonRequest(VALID_BODY));
    expect(response.status).toBe(200);
  });

  it("short-circuits when onRequest returns a Response", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const handler = makeHandler({
      onRequest: () => new Response("nope", { status: 401 }),
    });
    const response = await handler(jsonRequest(VALID_BODY));
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("continues when onRequest returns nothing", async () => {
    stubUpstream(() => sseUpstream());
    const handler = makeHandler({ onRequest: () => undefined });
    const response = await handler(jsonRequest(VALID_BODY));
    expect(response.status).toBe(200);
  });
});

describe("upstream failure", () => {
  it("returns a generic 502 without the key when upstream fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED (key: ${API_KEY})`);
      }),
    );
    const handler = makeHandler();
    const response = await handler(jsonRequest(VALID_BODY));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(API_KEY);
  });

  it("passes upstream error statuses through", async () => {
    stubUpstream(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          }),
          { status: 529, headers: { "content-type": "application/json" } },
        ),
    );
    const handler = makeHandler();
    const response = await handler(jsonRequest(VALID_BODY));
    expect(response.status).toBe(529);
  });
});

describe("nextAppRoute", () => {
  it("wraps the handler as { POST }", async () => {
    stubUpstream(() => sseUpstream());
    const handler = makeHandler();
    const route = nextAppRoute(handler);
    expect(Object.keys(route)).toEqual(["POST"]);
    const response = await route.POST(jsonRequest(VALID_BODY));
    expect(response.status).toBe(200);
  });
});

describe("toNodeHandler", () => {
  function fakeReq(opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
  }): IncomingMessage {
    const chunks = opts.body ? [new TextEncoder().encode(opts.body)] : [];
    return {
      method: opts.method ?? "POST",
      url: opts.url ?? "/api/agent",
      headers: {
        host: "localhost:3000",
        ...opts.headers,
      },
      socket: {},
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    } as unknown as IncomingMessage;
  }

  function fakeRes() {
    const state = {
      statusCode: 0,
      headersSent: false,
      ended: false,
      headers: {} as Record<string, string>,
      chunks: [] as Uint8Array[],
    };
    const res = {
      get statusCode() {
        return state.statusCode;
      },
      set statusCode(code: number) {
        state.statusCode = code;
      },
      get headersSent() {
        return state.headersSent;
      },
      setHeader(name: string, value: string) {
        state.headers[name.toLowerCase()] = String(value);
      },
      write(chunk: Uint8Array | string) {
        state.headersSent = true;
        state.chunks.push(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
        );
        return true;
      },
      end(chunk?: Uint8Array | string) {
        if (chunk !== undefined) {
          state.chunks.push(
            typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
          );
        }
        state.ended = true;
      },
    } as unknown as ServerResponse;
    const bodyText = () =>
      state.chunks.map((c) => new TextDecoder().decode(c)).join("");
    return { res, state, bodyText };
  }

  it("bridges Node req/res through the fetch handler (SSE included)", async () => {
    stubUpstream(() => sseUpstream());
    const node = toNodeHandler(makeHandler());
    const { res, state, bodyText } = fakeRes();
    await node(
      fakeReq({
        headers: {
          origin: SELF,
          "content-type": "application/json",
        },
        body: JSON.stringify(VALID_BODY),
      }),
      res,
    );
    expect(state.statusCode).toBe(200);
    expect(state.headers["content-type"]).toBe("text/event-stream");
    expect(state.ended).toBe(true);
    expect(bodyText()).toBe(SSE_CHUNKS.join(""));
  });

  it("propagates handler rejections as proper status codes (403)", async () => {
    const upstream = stubUpstream(() => sseUpstream());
    const node = toNodeHandler(makeHandler());
    const { res, state } = fakeRes();
    await node(
      fakeReq({
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify(VALID_BODY),
      }),
      res,
    );
    expect(state.statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("respects x-forwarded-proto when reconstructing the origin", async () => {
    stubUpstream(() => sseUpstream());
    const node = toNodeHandler(makeHandler());
    const { res, state } = fakeRes();
    await node(
      fakeReq({
        headers: {
          host: "app.example.com",
          "x-forwarded-proto": "https",
          origin: "https://app.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify(VALID_BODY),
      }),
      res,
    );
    expect(state.statusCode).toBe(200);
  });

  it("answers 500 when the wrapped handler itself throws", async () => {
    const node = toNodeHandler(async () => {
      throw new Error("boom");
    });
    const { res, state, bodyText } = fakeRes();
    await node(
      fakeReq({
        headers: { origin: SELF, "content-type": "application/json" },
        body: "{}",
      }),
      res,
    );
    expect(state.statusCode).toBe(500);
    expect(state.ended).toBe(true);
    expect(bodyText()).toContain("internal_error");
  });
});
