import type { ModelContextClient, ToolResult } from "webmcp-tools";
import { newId, randomNonce } from "./nonce.js";
import { pageToolSource } from "./source.js";
import {
  buildSystemPrompt,
  labelDescriptor,
  wrapUntrusted,
} from "./system-prompt.js";
import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentState,
  AgentStatus,
  ChatMessage,
  ContentBlock,
  Json,
  ProviderEvent,
  ProviderToolDescriptor,
  TextPart,
  ToolCallPart,
} from "./types.js";

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_TOKENS = 4096;
const RESULT_CHAR_LIMIT = 50_000;
const REPEAT_BREAK_AT = 3;

/** JSON.stringify with object keys sorted recursively (stable equality). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Macrotask + rAF yield so React/DOM state paints before a blocking confirm. */
async function paintYield(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (typeof requestAnimationFrame === "function") {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

function defaultApproval(req: { toolName: string; input: Json }): boolean {
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return window.confirm(
      `The conversation contains untrusted page content. Allow the assistant ` +
        `to run "${req.toolName}" anyway?`,
    );
  }
  return false; // headless: auto-deny
}

function resultText(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) +
    `\n[result truncated: shown ${limit} of ${text.length} chars]`
  );
}

export function createAgent(options: AgentOptions): Agent {
  const provider = options.provider;
  const toolSource = options.toolSource ?? pageToolSource();
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  // Taint guard cannot be disabled for the on-device builtin() provider.
  const taintGuard =
    provider.id === "builtin" ? true : (options.taintGuard ?? true);
  const untrustedByDefault = options.untrustedByDefault ?? false;
  const onApproval = options.onApproval ?? defaultApproval;
  const system = buildSystemPrompt(options.instructions);

  const listeners = new Set<(event: AgentEvent) => void>();

  // Conversation state (memory only — never persisted).
  let chat: ChatMessage[] = [];
  let messages: AgentMessage[] = [];
  let status: AgentStatus = "idle";
  let tools: ProviderToolDescriptor[] = [];
  let nonce = randomNonce();
  let tainted = false;
  let running = false;
  let generation = 0;
  let abortController: AbortController | null = null;
  const cumulative = { inputTokens: 0, outputTokens: 0 };

  function allowedName(name: string): boolean {
    if (options.denyTools?.includes(name)) return false; // deny wins
    if (options.allowTools && !options.allowTools.includes(name)) return false;
    return true;
  }

  function filterTools(
    all: ProviderToolDescriptor[],
  ): ProviderToolDescriptor[] {
    return all.filter((t) => allowedName(t.name));
  }

  tools = filterTools(toolSource.list());

  let snapshot: AgentState = { status, messages: [], tools };
  function commit(): void {
    snapshot = { status, messages: messages.slice(), tools };
  }

  function emit(event: AgentEvent): void {
    commit();
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("@josharsh/webmcp-agent: event listener threw", err);
      }
    }
  }

  function setStatus(next: AgentStatus): void {
    status = next;
    commit();
  }

  // Live tool updates: subscribe to the source while anyone listens to the
  // agent (the agent has no dispose(); tying the source subscription to
  // listener presence avoids leaking registry listeners).
  let unsubscribeSource: (() => void) | null = null;
  function refreshTools(): void {
    tools = filterTools(toolSource.list());
    emit({ type: "tools-changed", tools });
  }

  function pushMessage(gen: number, message: AgentMessage): void {
    if (gen !== generation) return; // reset() happened mid-turn
    messages.push(message);
    commit();
  }

  function pushChat(gen: number, message: ChatMessage): void {
    if (gen !== generation) return; // reset() happened mid-turn
    chat.push(message);
  }

  async function runTurn(
    gen: number,
    signal: AbortSignal,
  ): Promise<AgentMessage> {
    const assistant: AgentMessage = {
      id: newId("msg"),
      role: "assistant",
      parts: [],
    };
    pushMessage(gen, assistant);

    function notice(text: string): AgentMessage {
      const msg: AgentMessage = {
        id: newId("msg"),
        role: "system-notice",
        parts: [{ type: "text", text }],
      };
      pushMessage(gen, msg);
      return msg;
    }

    function finish(
      reason: "end-turn" | "max-iterations" | "aborted" | "error",
    ): void {
      setStatus(reason === "error" ? "error" : "idle");
      emit({ type: "done", reason });
    }

    let lastCallKey: string | null = null;
    let lastCallCount = 0;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      tools = filterTools(toolSource.list());
      commit();
      const labeled = tools.map(labelDescriptor);

      setStatus("streaming");
      let textPart: TextPart | null = null;
      let turnText = "";
      const calls: Array<{ id: string; name: string; input: Json }> = [];
      let providerError: unknown = null;
      let stopReason: "end-turn" | "tool-use" | "max-tokens" | null = null;

      try {
        for await (const ev of provider.chat({
          system,
          messages: chat,
          tools: labeled,
          maxTokens,
          signal,
        }) as AsyncIterable<ProviderEvent>) {
          if (ev.type === "text-delta") {
            if (textPart === null) {
              textPart = { type: "text", text: "" };
              assistant.parts.push(textPart);
            }
            textPart.text += ev.text;
            turnText += ev.text;
            emit({ type: "assistant-delta", text: ev.text });
          } else if (ev.type === "tool-call") {
            calls.push({ id: ev.id, name: ev.name, input: ev.input });
          } else if (ev.type === "done") {
            stopReason = ev.stopReason;
            if (ev.usage) {
              cumulative.inputTokens += ev.usage.inputTokens;
              cumulative.outputTokens += ev.usage.outputTokens;
              emit({
                type: "usage",
                inputTokens: ev.usage.inputTokens,
                outputTokens: ev.usage.outputTokens,
              });
              options.onUsage?.({
                inputTokens: ev.usage.inputTokens,
                outputTokens: ev.usage.outputTokens,
                cumulative: { ...cumulative },
              });
            }
          }
        }
      } catch (err) {
        providerError = err;
      }

      if (providerError !== null) {
        if (signal.aborted) {
          const msg = notice("Stopped.");
          finish("aborted");
          return msg;
        }
        const message =
          providerError instanceof Error
            ? providerError.message
            : String(providerError);
        emit({
          type: "error",
          code: "provider",
          message,
          cause: providerError,
        });
        const msg = notice(`The model provider failed: ${message}`);
        finish("error");
        return msg;
      }

      // Push the assistant turn (text + ALL tool_use blocks) into the wire
      // conversation.
      const content: ContentBlock[] = [];
      if (turnText !== "") content.push({ type: "text", text: turnText });
      for (const call of calls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        });
      }
      if (content.length > 0) {
        pushChat(gen, { role: "assistant", content });
      }
      emit({ type: "assistant-message", text: turnText });

      if (signal.aborted) {
        // The assistant turn (with tool_use blocks) is already in `chat` — a
        // later send() would 400 on Anthropic ("tool_use ids without
        // tool_result") unless every pending call is answered now.
        if (calls.length > 0) {
          pushChat(gen, {
            role: "user",
            content: calls.map((call) => ({
              type: "tool_result" as const,
              toolUseId: call.id,
              content: "Aborted by user before this tool ran.",
              isError: true,
            })),
          });
        }
        const msg = notice("Stopped.");
        finish("aborted");
        return msg;
      }

      if (calls.length === 0) {
        if (stopReason === "max-tokens") {
          // The provider hit the token limit mid-response (possibly dropping
          // a partial tool call) — surface that instead of ending silently.
          const msg = notice("Response was cut off at the token limit.");
          finish("end-turn");
          return msg;
        }
        finish("end-turn");
        return assistant;
      }

      // Execute tool calls SEQUENTIALLY in model order (page tools mutate
      // shared DOM state; confirm dialogs would race if parallel).
      setStatus("running-tool");
      const results: ContentBlock[] = [];
      let stop: "aborted" | "repeated-call" | null = null;

      for (let c = 0; c < calls.length; c++) {
        const call = calls[c]!;

        if (stop !== null) {
          // Keep the wire conversation valid: every tool_use must be answered.
          results.push({
            type: "tool_result",
            toolUseId: call.id,
            content:
              stop === "aborted"
                ? "Aborted by user before this tool ran."
                : "Stopped: repeated identical tool call.",
            isError: true,
          });
          continue;
        }

        // Repeated-call breaker: 3rd consecutive identical call.
        const key = `${call.name} ${stableStringify(call.input)}`;
        if (key === lastCallKey) lastCallCount += 1;
        else {
          lastCallKey = key;
          lastCallCount = 1;
        }
        if (lastCallCount >= REPEAT_BREAK_AT) {
          emit({
            type: "error",
            code: "repeated-call",
            message: `The model called "${call.name}" with identical input ${REPEAT_BREAK_AT} times in a row — stopping.`,
          });
          stop = "repeated-call";
          results.push({
            type: "tool_result",
            toolUseId: call.id,
            content: "Stopped: repeated identical tool call.",
            isError: true,
          });
          continue;
        }

        const descriptor = tools.find((t) => t.name === call.name);
        const readOnly = descriptor?.annotations?.readOnlyHint === true;
        // untrustedByDefault: tools that don't explicitly declare
        // untrustedContentHint: false are treated as untrusted.
        const untrustedHint = descriptor?.annotations?.untrustedContentHint;
        const untrusted =
          untrustedHint === true ||
          (untrustedByDefault && untrustedHint !== false);

        const part: ToolCallPart = {
          type: "tool-call",
          id: call.id,
          toolName: call.name,
          title: descriptor?.title ?? call.name,
          input: call.input,
          state: "running",
          readOnly,
          untrusted,
          startedAt: Date.now(),
        };
        assistant.parts.push(part);
        textPart = null;
        commit();

        let result: ToolResult;

        if (!descriptor || !allowedName(call.name)) {
          // Filtered or hallucinated tool name: errorResult without touching
          // executeTool.
          result = {
            content: [
              {
                type: "text",
                text: `Tool "${call.name}" is not available on this page.`,
              },
            ],
            isError: true,
          };
        } else {
          // Taint guard: untrusted content has entered the conversation, so
          // every mutating call needs explicit user approval.
          let denied = false;
          if (taintGuard && tainted && !readOnly) {
            part.state = "awaiting-approval";
            setStatus("awaiting-approval");
            emit({
              type: "approval-required",
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            });
            let approved = false;
            try {
              approved = await onApproval({
                toolName: call.name,
                input: call.input,
                reason: "tainted-context",
              });
            } catch {
              approved = false;
            }
            emit({
              type: "approval-resolved",
              toolCallId: call.id,
              approved,
            });
            if (!approved) {
              denied = true;
              part.state = "denied";
            } else {
              part.state = "running";
            }
            setStatus("running-tool");
          }

          if (denied) {
            result = {
              content: [{ type: "text", text: "User declined this action." }],
              isError: true,
            };
          } else {
            emit({
              type: "tool-call",
              id: call.id,
              name: call.name,
              input: call.input,
              readOnly,
            });
            const client: ModelContextClient = {
              requestUserInteraction: async <T>(
                callback: () => Promise<T> | T,
              ): Promise<T> => {
                emit({
                  type: "confirm-pending",
                  toolCallId: call.id,
                  toolName: call.name,
                });
                part.state = "awaiting-confirmation";
                setStatus("awaiting-confirmation");
                commit();
                // Let the pending state paint before a blocking confirm().
                await paintYield();
                try {
                  return await callback();
                } finally {
                  emit({ type: "confirm-resolved", toolCallId: call.id });
                  if (part.state === "awaiting-confirmation") {
                    part.state = "running";
                  }
                  setStatus("running-tool");
                }
              },
            };
            try {
              result = await toolSource.execute(call.name, call.input, client);
            } catch (err) {
              // ToolSource implementations shouldn't throw, but the model can
              // self-correct from an error result either way.
              const message = err instanceof Error ? err.message : String(err);
              result = {
                content: [
                  {
                    type: "text",
                    text: `Tool "${call.name}" failed: ${message}`,
                  },
                ],
                isError: true,
              };
            }
            if (untrusted) tainted = true;
          }
        }

        // Model-facing content: truncate the inner text first so the closing
        // nonce boundary survives, then wrap untrusted output.
        let content = truncate(resultText(result), RESULT_CHAR_LIMIT);
        if (untrusted && part.state !== "denied") {
          content = wrapUntrusted(content, nonce);
        }

        part.result = result;
        part.endedAt = Date.now();
        if (part.state !== "denied") {
          part.state = result.isError ? "error" : "success";
        }
        emit({
          type: "tool-result",
          id: call.id,
          name: call.name,
          result,
          untrusted,
        });

        results.push({
          type: "tool_result",
          toolUseId: call.id,
          content,
          ...(result.isError && { isError: true }),
        });

        if (signal.aborted && stop === null) stop = "aborted";
      }

      // ONE user message answering every tool_use, in call order.
      pushChat(gen, { role: "user", content: results });

      if (stop === "aborted") {
        const msg = notice("Stopped.");
        finish("aborted");
        return msg;
      }
      if (stop === "repeated-call") {
        const msg = notice(
          "Stopped: the model kept repeating the same tool call.",
        );
        finish("error");
        return msg;
      }
      if (signal.aborted) {
        const msg = notice("Stopped.");
        finish("aborted");
        return msg;
      }
    }

    emit({
      type: "error",
      code: "iteration-limit",
      message: `Paused after ${maxIterations} tool steps — reply to continue.`,
    });
    const msg = notice(
      `Paused after ${maxIterations} tool steps — reply to continue.`,
    );
    finish("max-iterations");
    return msg;
  }

  const agent: Agent = {
    async send(text, opts) {
      if (running) {
        throw new Error(
          "@josharsh/webmcp-agent: a turn is already running — await it or call abort() first.",
        );
      }
      running = true;
      const gen = generation;
      const controller = new AbortController();
      abortController = controller;
      const callerSignal = opts?.signal;
      let onCallerAbort: (() => void) | null = null;
      if (callerSignal) {
        if (callerSignal.aborted) controller.abort(callerSignal.reason);
        else {
          onCallerAbort = () => controller.abort(callerSignal.reason);
          callerSignal.addEventListener("abort", onCallerAbort, {
            once: true,
          });
        }
      }

      pushChat(gen, { role: "user", content: [{ type: "text", text }] });
      pushMessage(gen, {
        id: newId("msg"),
        role: "user",
        parts: [{ type: "text", text }],
      });
      emit({ type: "user-message", text });

      try {
        return await runTurn(gen, controller.signal);
      } finally {
        running = false;
        abortController = null;
        // Don't leak the abort listener when the caller reuses one signal
        // across many sends.
        if (callerSignal && onCallerAbort !== null) {
          callerSignal.removeEventListener("abort", onCallerAbort);
        }
      }
    },

    abort() {
      abortController?.abort();
    },

    reset() {
      generation += 1;
      abortController?.abort();
      chat = [];
      messages = [];
      nonce = randomNonce();
      tainted = false;
      cumulative.inputTokens = 0;
      cumulative.outputTokens = 0;
      setStatus("idle");
    },

    subscribe(listener) {
      listeners.add(listener);
      if (unsubscribeSource === null) {
        unsubscribeSource = toolSource.subscribe(refreshTools);
        refreshTools();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribeSource !== null) {
          unsubscribeSource();
          unsubscribeSource = null;
        }
      };
    },

    getState() {
      return snapshot;
    },
  };

  return agent;
}
