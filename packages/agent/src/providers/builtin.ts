import type {
  AgentProvider,
  ChatMessage,
  Json,
  ProviderChatRequest,
  ProviderEvent,
} from "../types.js";

/**
 * Chrome Prompt API (`LanguageModel`) provider — EXPERIMENTAL.
 *
 * The Prompt API proposal includes a native `tools` option, but (verified
 * 2026-06) tool calling is not on Chrome stable and the native design has the
 * BROWSER invoke execute callbacks — which would bypass our loop, confirm
 * surfacing, and taint guard. So v0.1 emulates tool calling via a
 * `responseConstraint` JSON-Schema union (stable since Chrome 138) with
 * layered parsing fallbacks; it degrades to a plain reply rather than crash.
 * Non-streaming: one text-delta (or one tool-call), then done. The agent
 * loop forces the taint guard ON for this provider.
 */

interface LanguageModelSession {
  prompt(
    input: string,
    options?: { responseConstraint?: object; signal?: AbortSignal },
  ): Promise<string>;
  destroy?(): void;
}

interface LanguageModelStatic {
  create(options?: {
    initialPrompts?: Array<{ role: string; content: string }>;
    temperature?: number;
    topK?: number;
    signal?: AbortSignal;
  }): Promise<LanguageModelSession>;
}

function languageModel(): LanguageModelStatic | undefined {
  const lm = (globalThis as { LanguageModel?: LanguageModelStatic })
    .LanguageModel;
  return lm && typeof lm.create === "function" ? lm : undefined;
}

/** Strip markdown code fences (```json ... ```) around a candidate payload. */
function stripFences(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fence ? fence[1]!.trim() : text.trim();
}

/**
 * Extract the first balanced top-level JSON object from prose-wrapped output.
 * Respects strings and escapes; never eval/Function.
 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

type Action =
  | { action: "tool_call"; name: string; input: Json }
  | { action: "reply"; text: string };

function parseAction(raw: string, toolNames: string[]): Action | null {
  const candidates = [raw.trim(), stripFences(raw)];
  const balanced = firstBalancedObject(stripFences(raw));
  if (balanced !== null) candidates.push(balanced);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (
      obj.action === "tool_call" &&
      typeof obj.name === "string" &&
      toolNames.includes(obj.name) &&
      typeof obj.input === "object" &&
      obj.input !== null &&
      !Array.isArray(obj.input)
    ) {
      return { action: "tool_call", name: obj.name, input: obj.input as Json };
    }
    if (obj.action === "reply" && typeof obj.text === "string") {
      return { action: "reply", text: obj.text };
    }
  }
  return null;
}

function buildConstraint(toolNames: string[]): object {
  const reply = {
    type: "object",
    properties: {
      action: { const: "reply" },
      text: { type: "string" },
    },
    required: ["action", "text"],
    additionalProperties: false,
  };
  if (toolNames.length === 0) return reply;
  return {
    oneOf: [
      {
        type: "object",
        properties: {
          action: { const: "tool_call" },
          name: { enum: toolNames },
          input: { type: "object" },
        },
        required: ["action", "name", "input"],
        additionalProperties: false,
      },
      reply,
    ],
  };
}

function renderMessage(message: ChatMessage): string {
  const lines: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      lines.push(
        `${message.role === "user" ? "User" : "Assistant"}: ${block.text}`,
      );
    } else if (block.type === "tool_use") {
      lines.push(
        `Assistant called tool "${block.name}" with input ${JSON.stringify(block.input)}`,
      );
    } else {
      lines.push(
        `Tool result (${block.isError ? "ERROR" : "ok"}) for call ${block.toolUseId}: ${block.content}`,
      );
    }
  }
  return lines.join("\n");
}

function renderPrompt(request: ProviderChatRequest): string {
  const tools =
    request.tools.length > 0
      ? request.tools
          .map(
            (t) =>
              `- ${t.name}: ${t.description} (input schema: ${JSON.stringify(t.inputSchema)})`,
          )
          .join("\n")
      : "(none)";
  const transcript = request.messages.map(renderMessage).join("\n");
  return (
    `Available tools:\n${tools}\n\n` +
    `Conversation so far:\n${transcript}\n\n` +
    "Respond with ONLY one JSON object, no prose, in one of these shapes:\n" +
    '{"action":"tool_call","name":"<tool name>","input":{...}} to call a tool, or\n' +
    '{"action":"reply","text":"<your reply to the user>"} to answer directly.'
  );
}

const REPROMPT =
  "Your previous response was not valid JSON. Respond again with ONLY a " +
  'single JSON object: {"action":"tool_call","name":"<tool name>","input":{...}} ' +
  'or {"action":"reply","text":"..."}. No prose, no code fences.';

export function builtin(
  opts: { temperature?: number; topK?: number } = {},
): AgentProvider {
  const lm = languageModel();
  if (!lm) {
    throw new Error(
      "@josharsh/webmcp-agent: builtin() requires the Chrome Prompt API " +
        "(LanguageModel), which is not available in this browser. It ships " +
        "in Chrome 138+ on supported hardware. Use demo(), proxy(), or " +
        "anthropic() instead.",
    );
  }

  let callSeq = 0;

  async function* chat(
    request: ProviderChatRequest,
  ): AsyncGenerator<ProviderEvent, void, undefined> {
    // First call may trigger a model download — slow first run, no progress
    // UI in v0.1 (documented).
    const session = await lm!.create({
      initialPrompts: [{ role: "system", content: request.system }],
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.topK !== undefined && { topK: opts.topK }),
      signal: request.signal,
    });

    try {
      const toolNames = request.tools.map((t) => t.name);
      const constraint = buildConstraint(toolNames);
      const prompt = renderPrompt(request);

      let output: string;
      try {
        output = await session.prompt(prompt, {
          responseConstraint: constraint,
          signal: request.signal,
        });
      } catch (err) {
        // Older Chrome: responseConstraint unsupported → unconstrained retry.
        if (err instanceof Error && err.name === "NotSupportedError") {
          output = await session.prompt(prompt, { signal: request.signal });
        } else {
          throw err;
        }
      }

      let action = parseAction(output, toolNames);
      if (action === null) {
        // One re-prompt with explicit JSON instructions...
        const retry = await session.prompt(REPROMPT, {
          signal: request.signal,
        });
        action = parseAction(retry, toolNames);
        if (action === null) {
          // ...then degrade: treat the original output as a plain reply.
          action = { action: "reply", text: output.trim() };
        }
      }

      if (action.action === "tool_call") {
        yield {
          type: "tool-call",
          id: `builtin-call-${++callSeq}`,
          name: action.name,
          input: action.input,
        };
        yield { type: "done", stopReason: "tool-use" };
      } else {
        yield { type: "text-delta", text: action.text };
        yield { type: "done", stopReason: "end-turn" };
      }
    } finally {
      session.destroy?.();
    }
  }

  return {
    id: "builtin",
    label: "On-device (Chrome)",
    kind: "on-device",
    experimental: true,
    chat,
  };
}
