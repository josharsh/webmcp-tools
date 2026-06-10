import type {
  AgentProvider,
  ChatMessage,
  ContentBlock,
  DemoRule,
  Json,
  ProviderChatRequest,
  ProviderEvent,
  ProviderToolDescriptor,
} from "../types.js";

/**
 * Deterministic scripted provider — zero config, zero network, never AI.
 * Powers the widget out of the box and is the test workhorse: it routes
 * keywords to registered tools (or follows an explicit script) and produces a
 * genuine two-iteration loop (call tools, then summarize their results).
 */
export function demo(opts: { script?: DemoRule[] } = {}): AgentProvider {
  let callSeq = 0;
  const nextId = () => `demo-call-${++callSeq}`;

  return {
    id: "demo",
    label: "Demo (scripted — not AI)",
    kind: "scripted",
    chat: (request) => run(request, opts.script ?? [], nextId),
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Stream text as 2–3 word-boundary chunks (deterministic). */
function* chunked(text: string): Generator<ProviderEvent> {
  const words = text.split(" ");
  const chunks = words.length < 6 ? 2 : 3; // short replies in 2 chunks, longer in 3
  const per = Math.ceil(words.length / chunks);
  for (let i = 0; i < words.length; i += per) {
    const piece = words.slice(i, i + per).join(" ");
    const lead = i === 0 ? "" : " ";
    yield { type: "text-delta", text: lead + piece };
  }
}

function lastUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i];
  }
  return undefined;
}

function textOf(message: ChatMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

function toolResultsOf(
  message: ChatMessage | undefined,
): Array<Extract<ContentBlock, { type: "tool_result" }>> {
  if (!message) return [];
  return message.content.filter(
    (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
      b.type === "tool_result",
  );
}

/** Map tool_use ids back to names so summaries can mention the tool. */
function toolNameById(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") map.set(block.id, block.name);
    }
  }
  return map;
}

function snippet(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** Score a tool against user tokens (name, title, description overlap). */
function scoreTool(tool: ProviderToolDescriptor, tokens: string[]): number {
  const haystack = new Set([
    ...tokenize(tool.name.replace(/[-_.]/g, " ")),
    ...tokenize(tool.title ?? ""),
    ...tokenize(tool.description),
  ]);
  let score = 0;
  for (const token of tokens) {
    if (haystack.has(token)) score += 1;
  }
  return score;
}

/**
 * Extract an input object from the user's text using the tool's schema:
 * enum values found in the text, numbers in order of appearance, quoted
 * spans, and `prop: value` patterns.
 */
function extractInput(tool: ProviderToolDescriptor, text: string): Json {
  const input: Json = {};
  const properties =
    (tool.inputSchema.properties as Record<string, Record<string, unknown>>) ??
    {};
  const lower = text.toLowerCase();

  const numbers = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  let numberCursor = 0;
  const quoted: string[] = [];
  for (const m of text.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    quoted.push((m[1] ?? m[2])!);
  }
  let quoteCursor = 0;

  for (const [name, schema] of Object.entries(properties)) {
    const type = schema.type as string | undefined;
    const enumValues = schema.enum as unknown[] | undefined;

    if (Array.isArray(enumValues)) {
      const hit = enumValues.find(
        (v) => typeof v === "string" && lower.includes(v.toLowerCase()),
      );
      if (hit !== undefined) input[name] = hit;
      continue;
    }
    if (type === "number" || type === "integer") {
      // Prefer "prop: 4" / "prop 4" near the property name, else next number.
      const near = new RegExp(
        `${name}\\s*[:=]?\\s*(-?\\d+(?:\\.\\d+)?)`,
        "i",
      ).exec(text);
      if (near) {
        input[name] = Number(near[1]);
      } else if (numberCursor < numbers.length) {
        input[name] = numbers[numberCursor++];
      }
      continue;
    }
    if (type === "boolean") {
      if (lower.includes(name.toLowerCase())) input[name] = true;
      continue;
    }
    // strings (and untyped): quoted span first, then `prop: value`.
    if (quoteCursor < quoted.length) {
      input[name] = quoted[quoteCursor++];
      continue;
    }
    const near = new RegExp(`${name}\\s*[:=]\\s*(\\S+)`, "i").exec(text);
    if (near) input[name] = near[1];
  }
  return input;
}

async function* run(
  request: ProviderChatRequest,
  script: DemoRule[],
  nextId: () => string,
): AsyncGenerator<ProviderEvent, void, undefined> {
  const last = lastUserMessage(request.messages);
  const results = toolResultsOf(last);

  // Second loop iteration: the page ran our tool calls — summarize.
  if (results.length > 0) {
    const names = toolNameById(request.messages);
    const lines = results.map((r) => {
      const name = names.get(r.toolUseId) ?? r.toolUseId;
      return r.isError
        ? `${name} failed: ${snippet(r.content)}`
        : `${name} returned: ${snippet(r.content)}`;
    });
    const summary = `Done. ${lines.join(" · ")}`;
    yield* chunked(summary);
    yield { type: "done", stopReason: "end-turn" };
    return;
  }

  const text = textOf(last);

  // Scripted rules: first match on the latest user message wins.
  for (const rule of script) {
    const matched =
      typeof rule.match === "string"
        ? text.toLowerCase().includes(rule.match.toLowerCase())
        : rule.match.test(text);
    if (!matched) continue;
    yield* chunked(rule.reply);
    const calls = rule.toolCalls ?? [];
    for (const call of calls) {
      yield {
        type: "tool-call",
        id: nextId(),
        name: call.name,
        input: call.input,
      };
    }
    yield {
      type: "done",
      stopReason: calls.length > 0 ? "tool-use" : "end-turn",
    };
    return;
  }

  // Default behavior: match the user text to a discovered tool.
  const tokens = tokenize(text);
  let best: ProviderToolDescriptor | null = null;
  let bestScore = 0;
  for (const tool of request.tools) {
    const score = scoreTool(tool, tokens);
    if (score > bestScore) {
      best = tool;
      bestScore = score;
    }
  }

  if (best) {
    const input = extractInput(best, text);
    yield* chunked(
      `I'll use the "${best.title ?? best.name}" tool for that — calling it now.`,
    );
    yield { type: "tool-call", id: nextId(), name: best.name, input };
    yield { type: "done", stopReason: "tool-use" };
    return;
  }

  // Nothing matched: greet and list what this page can do.
  const toolList =
    request.tools.length > 0
      ? `This page exposes ${request.tools.length} tool${
          request.tools.length === 1 ? "" : "s"
        }: ${request.tools.map((t) => t.title ?? t.name).join(", ")}. Ask me to use one of them.`
      : "This page hasn't registered any tools yet.";
  yield* chunked(`Hi! I'm a scripted demo assistant (not AI). ${toolList}`);
  yield { type: "done", stopReason: "end-turn" };
}
