import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Fetch-style server proxy for the Anthropic Messages API. Pairs with
 * proxy({ url }) from "@josharsh/webmcp-agent" — identical wire protocol: this
 * is an authenticating passthrough, not a translator. The server holds the
 * API key; the browser never sees it.
 *
 * IMPORTANT: the Origin check stops drive-by browser abuse but is NOT
 * authentication — any non-browser client can set any Origin header. Public
 * deployments need rateLimit and/or an onRequest auth hook.
 */
export interface AgentHandlerOptions {
  /** Default process.env.ANTHROPIC_API_KEY; never echoed in any response. */
  apiKey?: string;
  /** PINNED; clients may omit model (it is injected); a mismatch → 400. */
  model: string;
  /** Default "https://api.anthropic.com". */
  baseURL?: string;
  /**
   * Default "same-origin" (Origin header must match the request URL origin).
   * Missing or mismatched Origin → 403. "any" must be typed explicitly.
   */
  allowedOrigins?: "same-origin" | string[] | "any";
  /** Default 1_048_576 (1 MiB). Larger request bodies → 413. */
  maxBodyBytes?: number;
  /** Server-side clamp of max_tokens. Default 4096. */
  maxTokens?: number;
  /** Return false → 429. No default implementation. */
  rateLimit?: (request: Request) => boolean | Promise<boolean>;
  /**
   * Runs first on every request (auth, logging). Returning a Response
   * short-circuits the handler with it.
   */
  onRequest?: (
    request: Request,
  ) => Response | undefined | void | Promise<Response | undefined | void>;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = "2023-06-01";

/** Response headers that must not be forwarded verbatim: the runtime
 * re-frames the body, so upstream encoding/length headers would be wrong. */
const STRIP_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
];

function errorResponse(
  status: number,
  type: string,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status,
      headers: { "content-type": "application/json", ...extraHeaders },
    },
  );
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function originAllowed(
  request: Request,
  policy: "same-origin" | string[] | "any",
): boolean {
  if (policy === "any") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (policy === "same-origin") {
    try {
      return new URL(request.url).origin === origin;
    } catch {
      return false;
    }
  }
  return policy.some((allowed) => stripTrailingSlash(allowed) === origin);
}

/**
 * Create a fetch-style (Request → Response) handler that proxies the
 * Anthropic Messages wire protocol with a server-held key. Throws at
 * construction when no API key is available — fail fast at boot, not on the
 * first user request.
 */
export function createAgentHandler(
  opts: AgentHandlerOptions,
): (request: Request) => Promise<Response> {
  const apiKey =
    opts.apiKey ??
    (typeof process !== "undefined"
      ? process.env.ANTHROPIC_API_KEY
      : undefined);
  if (!apiKey) {
    throw new Error(
      "@josharsh/webmcp-agent/server: createAgentHandler needs an API key — " +
        "pass { apiKey } or set the ANTHROPIC_API_KEY environment variable.",
    );
  }
  if (!opts.model) {
    throw new Error(
      "@josharsh/webmcp-agent/server: createAgentHandler requires { model } — " +
        "the server pins the model; clients cannot choose one.",
    );
  }

  const model = opts.model;
  const baseURL = stripTrailingSlash(opts.baseURL ?? DEFAULT_BASE_URL);
  const allowedOrigins = opts.allowedOrigins ?? "same-origin";
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  return async function handler(request: Request): Promise<Response> {
    if (opts.onRequest) {
      const short = await opts.onRequest(request);
      if (short instanceof Response) return short;
    }

    if (request.method !== "POST") {
      return errorResponse(
        405,
        "method_not_allowed",
        "Only POST is supported.",
        { allow: "POST" },
      );
    }

    if (!originAllowed(request, allowedOrigins)) {
      return errorResponse(
        403,
        "origin_forbidden",
        "Request origin is not allowed.",
      );
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return errorResponse(
        415,
        "unsupported_media_type",
        "Content-Type must be application/json.",
      );
    }

    if (opts.rateLimit && !(await opts.rateLimit(request))) {
      return errorResponse(429, "rate_limited", "Too many requests.");
    }

    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return errorResponse(
        413,
        "payload_too_large",
        `Request body exceeds ${maxBodyBytes} bytes.`,
      );
    }

    let raw: ArrayBuffer;
    try {
      raw = await request.arrayBuffer();
    } catch {
      return errorResponse(
        400,
        "invalid_request",
        "Could not read the request body.",
      );
    }
    if (raw.byteLength > maxBodyBytes) {
      return errorResponse(
        413,
        "payload_too_large",
        `Request body exceeds ${maxBodyBytes} bytes.`,
      );
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return errorResponse(
          400,
          "invalid_request",
          "Body must be a JSON object.",
        );
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return errorResponse(400, "invalid_request", "Body must be valid JSON.");
    }

    // Model pin: clients may omit model (injected) — anything else must match.
    if (body.model !== undefined && body.model !== model) {
      return errorResponse(
        400,
        "model_not_allowed",
        `This endpoint only serves model "${model}".`,
      );
    }
    body.model = model;

    // Server-side max_tokens clamp.
    const requested = body.max_tokens;
    body.max_tokens =
      typeof requested === "number" && requested > 0
        ? Math.min(requested, maxTokens)
        : maxTokens;

    let upstream: Response;
    try {
      upstream = await fetch(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version":
            request.headers.get("anthropic-version") ?? ANTHROPIC_VERSION,
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch {
      // Generic on purpose: upstream failures must never echo request
      // details or anything that could contain the key.
      return errorResponse(
        502,
        "upstream_error",
        "Failed to reach the Anthropic API.",
      );
    }

    // Stream the upstream body through verbatim — no buffering, so SSE
    // chunks reach the browser as they arrive.
    const headers = new Headers(upstream.headers);
    for (const name of STRIP_RESPONSE_HEADERS) headers.delete(name);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  };
}

/**
 * Next.js App Router adapter:
 *
 *   export const { POST } = nextAppRoute(createAgentHandler({ model: "…" }));
 */
export function nextAppRoute(
  handler: (request: Request) => Promise<Response>,
): {
  POST: (request: Request) => Promise<Response>;
} {
  return { POST: handler };
}

/**
 * Plain Node http.Server / Express adapter:
 *
 *   const node = toNodeHandler(createAgentHandler({ model: "…" }));
 *   http.createServer(node).listen(3001);          // Node
 *   app.post("/api/agent", node);                  // Express — mount BEFORE
 *                                                  // express.json() (the
 *                                                  // adapter reads the raw
 *                                                  // body stream itself)
 */
export function toNodeHandler(
  handler: (request: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function nodeHandler(req, res): Promise<void> {
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of req) {
        const bytes =
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        chunks.push(bytes);
        total += bytes.byteLength;
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const bytes of chunks) {
        body.set(bytes, offset);
        offset += bytes.byteLength;
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.set(name, value);
        }
      }

      const forwardedProto = req.headers["x-forwarded-proto"];
      const proto =
        (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
          ?.split(",")[0]
          ?.trim() ||
        ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
      const host = req.headers.host ?? "localhost";
      const url = `${proto}://${host}${req.url ?? "/"}`;

      const request = new Request(url, {
        method: req.method ?? "GET",
        headers,
        ...(total > 0 && { body }),
      });

      const response = await handler(request);
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "internal_error",
              message: "Internal server error.",
            },
          }),
        );
      } else {
        res.end();
      }
    }
  };
}
