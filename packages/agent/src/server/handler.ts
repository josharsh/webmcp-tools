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
   * With an array or "any", the handler also speaks CORS for allowed
   * origins: OPTIONS preflights → 204 with Access-Control-* headers, and
   * every response (SSE and errors included) carries
   * Access-Control-Allow-Origin (the validated origin, never a reflection)
   * + Vary: Origin. The same-origin default sends no CORS headers and
   * answers OPTIONS with 405.
   */
  allowedOrigins?: "same-origin" | string[] | "any";
  /**
   * Default 1_048_576 (1 MiB). Enforced while the body is read, so chunked
   * bodies without a Content-Length are bounded too → 413.
   */
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

/**
 * Exactly the headers the browser client sends: proxy() (src/providers/
 * wire.ts) sets content-type + anthropic-version and nothing else — it never
 * sends x-api-key (the server holds the key), so x-api-key is NOT allowed.
 */
const CORS_ALLOW_HEADERS = "content-type, anthropic-version";
const CORS_MAX_AGE = "86400";

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
  // CORS only applies to the explicit cross-origin modes; the same-origin
  // default keeps the original behavior (no CORS headers, OPTIONS → 405).
  const corsEnabled = allowedOrigins !== "same-origin";

  /** The validated origin to echo in CORS headers, or null (no CORS). */
  const corsOrigin = (request: Request): string | null => {
    if (!corsEnabled) return null;
    const origin = request.headers.get("origin");
    if (!origin) return null;
    if (allowedOrigins === "any") return origin;
    return allowedOrigins.some(
      (allowed) => stripTrailingSlash(allowed) === origin,
    )
      ? origin
      : null;
  };

  const inner = async (request: Request): Promise<Response> => {
    if (opts.onRequest) {
      const short = await opts.onRequest(request);
      if (short instanceof Response) return short;
    }

    if (corsEnabled && request.method === "OPTIONS") {
      // Preflight. Allow-Origin + Vary are added by the outer wrapper for
      // every response from a validated origin (this one included).
      if (corsOrigin(request) === null) {
        return errorResponse(
          403,
          "origin_forbidden",
          "Request origin is not allowed.",
        );
      }
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "POST",
          "access-control-allow-headers": CORS_ALLOW_HEADERS,
          "access-control-max-age": CORS_MAX_AGE,
        },
      });
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

    // Read the body incrementally and stop the moment it exceeds the cap —
    // chunked bodies carry no Content-Length, so the header check above
    // can't bound them, and buffering first (arrayBuffer()) would let an
    // attacker exhaust memory before any size check ran.
    let raw: Uint8Array;
    if (request.body === null) {
      raw = new Uint8Array(0);
    } else {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBodyBytes) {
            try {
              await reader.cancel();
            } catch {
              // stream already closed/errored
            }
            return errorResponse(
              413,
              "payload_too_large",
              `Request body exceeds ${maxBodyBytes} bytes.`,
            );
          }
          chunks.push(value);
        }
      } catch {
        return errorResponse(
          400,
          "invalid_request",
          "Could not read the request body.",
        );
      }
      raw = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        raw.set(chunk, offset);
        offset += chunk.byteLength;
      }
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

  return async function handler(request: Request): Promise<Response> {
    const response = await inner(request);
    // CORS modes: every response for a VALIDATED origin (preflight, SSE,
    // errors) carries Allow-Origin + Vary. Never reflect an unvalidated
    // Origin; same-origin mode adds nothing.
    const origin = corsOrigin(request);
    if (origin !== null) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.append("vary", "Origin");
    }
    return response;
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
  options: { maxBodyBytes?: number } = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return async function nodeHandler(req, res): Promise<void> {
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of req) {
        const bytes =
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        total += bytes.byteLength;
        if (total > maxBodyBytes) {
          // Stop buffering immediately: respond 413 and tear the request
          // stream down (the wrapped handler never runs).
          res.statusCode = 413;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              type: "error",
              error: {
                type: "payload_too_large",
                message: `Request body exceeds ${maxBodyBytes} bytes.`,
              },
            }),
          );
          req.destroy();
          return;
        }
        chunks.push(bytes);
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
          // Backpressure: write() returning false means the socket buffer is
          // full — wait for 'drain' before pulling the next chunk.
          if (!res.write(value)) {
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
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
