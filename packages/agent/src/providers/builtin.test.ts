import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatMessage,
  ProviderChatRequest,
  ProviderEvent,
} from "../types.js";
import { builtin } from "./builtin.js";

interface PromptCall {
  input: string;
  options?: { responseConstraint?: object; signal?: AbortSignal };
}

function installFakeLM(
  respond: (call: PromptCall, callIndex: number) => string | Promise<string>,
) {
  const promptCalls: PromptCall[] = [];
  const destroyed = { count: 0 };
  const createOptions: Array<Record<string, unknown>> = [];
  const fake = {
    async create(options?: Record<string, unknown>) {
      createOptions.push(options ?? {});
      return {
        async prompt(
          input: string,
          options?: { responseConstraint?: object; signal?: AbortSignal },
        ) {
          const call: PromptCall = { input, ...(options && { options }) };
          promptCalls.push(call);
          return respond(call, promptCalls.length - 1);
        },
        destroy() {
          destroyed.count += 1;
        },
      };
    },
  };
  vi.stubGlobal("LanguageModel", fake);
  return { promptCalls, destroyed, createOptions };
}

function makeRequest(messages?: ChatMessage[]): ProviderChatRequest {
  return {
    system: "system prompt here",
    messages: messages ?? [
      { role: "user", content: [{ type: "text", text: "switch theme" }] },
    ],
    tools: [
      {
        name: "set-theme",
        description: "Switch the theme",
        inputSchema: {
          type: "object",
          properties: { theme: { enum: ["light", "dark"] } },
        },
      },
    ],
    maxTokens: 4096,
    signal: new AbortController().signal,
  };
}

async function collect(iterable: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("builtin() availability", () => {
  it("throws when the Prompt API is unavailable", () => {
    expect(() => builtin()).toThrow(/LanguageModel/);
  });

  it("is marked experimental and on-device", () => {
    installFakeLM(() => '{"action":"reply","text":"hi"}');
    const provider = builtin();
    expect(provider.experimental).toBe(true);
    expect(provider.kind).toBe("on-device");
    expect(provider.id).toBe("builtin");
  });
});

describe("builtin() tool-call emulation", () => {
  it("uses responseConstraint and parses a clean tool_call", async () => {
    const { promptCalls, destroyed, createOptions } = installFakeLM(() =>
      JSON.stringify({
        action: "tool_call",
        name: "set-theme",
        input: { theme: "dark" },
      }),
    );
    const events = await collect(builtin().chat(makeRequest()));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "tool-call",
      name: "set-theme",
      input: { theme: "dark" },
    });
    expect(events[1]).toEqual({ type: "done", stopReason: "tool-use" });
    // responseConstraint passed; system prompt seeded via initialPrompts.
    expect(promptCalls[0]!.options?.responseConstraint).toBeDefined();
    expect(createOptions[0]!.initialPrompts).toEqual([
      { role: "system", content: "system prompt here" },
    ]);
    expect(destroyed.count).toBe(1);
  });

  it("strips code fences around the JSON", async () => {
    installFakeLM(
      () => '```json\n{"action":"reply","text":"fenced hello"}\n```',
    );
    const events = await collect(builtin().chat(makeRequest()));
    expect(events[0]).toEqual({ type: "text-delta", text: "fenced hello" });
    expect(events[1]).toEqual({ type: "done", stopReason: "end-turn" });
  });

  it("extracts the first balanced object from prose-wrapped output", async () => {
    installFakeLM(
      () =>
        'Sure thing! {"action":"tool_call","name":"set-theme","input":{"theme":"light","note":"a {nested} brace in a string"}} hope that helps',
    );
    const events = await collect(builtin().chat(makeRequest()));
    expect(events[0]).toMatchObject({
      type: "tool-call",
      name: "set-theme",
      input: { theme: "light", note: "a {nested} brace in a string" },
    });
  });

  it("re-prompts once on garbage, then succeeds", async () => {
    const { promptCalls } = installFakeLM((_call, index) =>
      index === 0
        ? "I think you should use the theme tool maybe?"
        : '{"action":"reply","text":"second try"}',
    );
    const events = await collect(builtin().chat(makeRequest()));
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[1]!.input).toContain("not valid JSON");
    expect(events[0]).toEqual({ type: "text-delta", text: "second try" });
  });

  it("degrades to a plain reply when both attempts are unparseable", async () => {
    installFakeLM((_call, index) =>
      index === 0 ? "Just plain prose, no JSON at all" : "still not json",
    );
    const events = await collect(builtin().chat(makeRequest()));
    expect(events[0]).toEqual({
      type: "text-delta",
      text: "Just plain prose, no JSON at all",
    });
    expect(events[1]).toEqual({ type: "done", stopReason: "end-turn" });
  });

  it("rejects tool calls for names that are not registered", async () => {
    // A hallucinated tool name fails shape validation → re-prompt → degrade.
    installFakeLM((_call, index) =>
      index === 0
        ? '{"action":"tool_call","name":"ghost-tool","input":{}}'
        : "nope",
    );
    const events = await collect(builtin().chat(makeRequest()));
    expect(events.some((e) => e.type === "tool-call")).toBe(false);
    expect(events[1]).toEqual({ type: "done", stopReason: "end-turn" });
  });

  it("falls back to an unconstrained retry on NotSupportedError", async () => {
    const { promptCalls } = installFakeLM((call) => {
      if (call.options?.responseConstraint) {
        const err = new Error("responseConstraint not supported");
        err.name = "NotSupportedError";
        throw err;
      }
      return '{"action":"reply","text":"unconstrained"}';
    });
    const events = await collect(builtin().chat(makeRequest()));
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[1]!.options?.responseConstraint).toBeUndefined();
    expect(events[0]).toEqual({ type: "text-delta", text: "unconstrained" });
  });

  it("renders tool results into the transcript for multi-turn loops", async () => {
    const { promptCalls } = installFakeLM(
      () => '{"action":"reply","text":"summary"}',
    );
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "switch theme" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "b1",
            name: "set-theme",
            input: { theme: "dark" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "b1",
            content: "theme set to dark",
          },
        ],
      },
    ];
    await collect(builtin().chat(makeRequest(messages)));
    const prompt = promptCalls[0]!.input;
    expect(prompt).toContain('called tool "set-theme"');
    expect(prompt).toContain("theme set to dark");
    expect(prompt).toContain("set-theme: Switch the theme");
  });

  it("destroys the session even when prompting throws", async () => {
    const { destroyed } = installFakeLM(() => {
      throw new Error("model crashed");
    });
    await expect(collect(builtin().chat(makeRequest()))).rejects.toThrow(
      /model crashed/,
    );
    expect(destroyed.count).toBe(1);
  });
});
