import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { getRegisteredTools, tool } from "webmcp-tools";
import { demo } from "../providers/demo.js";
import type {
  AgentProvider,
  AgentStatus,
  ProviderEvent,
  ToolCallPart,
} from "../types.js";
import { useAgent } from "./use-agent.js";

afterEach(() => {
  cleanup();
  for (const t of getRegisteredTools()) t.unregister();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Provider that counts chat() invocations and replies with plain text. */
function countingProvider(): { provider: AgentProvider; calls: () => number } {
  let calls = 0;
  const provider: AgentProvider = {
    id: "counting",
    label: "Counting test provider",
    kind: "scripted",
    async *chat(): AsyncGenerator<ProviderEvent> {
      calls += 1;
      yield { type: "text-delta", text: "ok" };
      yield { type: "done", stopReason: "end-turn" };
    },
  };
  return { provider, calls: () => calls };
}

/** Provider that streams until aborted (rejects like a real fetch). */
function hangingProvider(): AgentProvider {
  return {
    id: "hanging",
    label: "Hanging test provider",
    kind: "scripted",
    async *chat(request): AsyncGenerator<ProviderEvent> {
      yield { type: "text-delta", text: "thinking" };
      while (!request.signal.aborted) {
        await sleep(5);
      }
      throw new DOMException("The operation was aborted.", "AbortError");
    },
  };
}

describe("useAgent", () => {
  it("does not double-run a turn under StrictMode double-mount", async () => {
    const { provider, calls } = countingProvider();
    const { result } = renderHook(() => useAgent({ provider }), {
      wrapper: StrictMode,
    });

    await act(async () => {
      await result.current.send("hello");
    });

    expect(calls()).toBe(1);
    const userMessages = result.current.messages.filter(
      (m) => m.role === "user",
    );
    expect(userMessages).toHaveLength(1);
    expect(result.current.status).toBe("idle");
  });

  it("runs a real tool turn with demo(): status transitions and tool parts", async () => {
    tool("add-todo", {
      description: "Add a todo item to the list",
      input: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      // Async run forces a macrotask so "running-tool" is observable.
      run: async (args) => {
        await sleep(5);
        return `added ${(args as { text?: string }).text ?? ""}`;
      },
    });

    const provider = demo();
    const statuses: AgentStatus[] = [];
    const { result } = renderHook(() => {
      const hook = useAgent({ provider });
      statuses.push(hook.status);
      return hook;
    });

    await act(async () => {
      await result.current.send('add a todo "buy milk"');
    });

    expect(statuses).toContain("streaming");
    expect(statuses).toContain("running-tool");
    expect(result.current.status).toBe("idle");

    const assistant = result.current.messages.filter(
      (m) => m.role === "assistant",
    );
    expect(assistant.length).toBeGreaterThanOrEqual(1);
    const toolParts = assistant.flatMap((m) =>
      m.parts.filter((p): p is ToolCallPart => p.type === "tool-call"),
    );
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]!.toolName).toBe("add-todo");
    expect(toolParts[0]!.state).toBe("success");
    expect(toolParts[0]!.input).toEqual({ text: "buy milk" });

    // demo() loops a second iteration to summarize tool results.
    const finalText = assistant[assistant.length - 1]!.parts.filter(
      (p) => p.type === "text",
    );
    expect(finalText.length).toBeGreaterThan(0);
  });

  it("surfaces provider failures as error and clears it on the next turn", async () => {
    let failNext = true;
    const provider: AgentProvider = {
      id: "flaky",
      label: "Flaky test provider",
      kind: "scripted",
      async *chat(): AsyncGenerator<ProviderEvent> {
        if (failNext) {
          failNext = false;
          throw new Error("boom: upstream 500");
        }
        yield { type: "text-delta", text: "recovered" };
        yield { type: "done", stopReason: "end-turn" };
      },
    };
    const { result } = renderHook(() => useAgent({ provider }));

    await act(async () => {
      await result.current.send("first");
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error!.message).toContain("boom: upstream 500");

    await act(async () => {
      await result.current.send("second");
    });
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("idle");
  });

  it("stop() aborts a streaming turn and lands on a Stopped notice", async () => {
    const provider = hangingProvider();
    const { result } = renderHook(() => useAgent({ provider }));

    let turn!: Promise<void>;
    act(() => {
      turn = result.current.send("go");
    });
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    act(() => {
      result.current.stop();
    });
    await act(async () => {
      await turn;
    });

    expect(result.current.status).toBe("idle");
    const last = result.current.messages[result.current.messages.length - 1]!;
    expect(last.role).toBe("system-notice");
    expect(last.parts[0]).toEqual({ type: "text", text: "Stopped." });
  });

  it("reset() clears messages and error and re-renders", async () => {
    const provider: AgentProvider = {
      id: "boom",
      label: "Boom",
      kind: "scripted",
      // eslint-disable-next-line require-yield
      async *chat(): AsyncGenerator<ProviderEvent> {
        throw new Error("always fails");
      },
    };
    const { result } = renderHook(() => useAgent({ provider }));
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.messages.length).toBeGreaterThan(0);
    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.reset();
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("idle");
  });

  it("keeps snapshot references stable across no-op re-renders", async () => {
    const { provider } = countingProvider();
    const { result, rerender } = renderHook(() => useAgent({ provider }));
    await act(async () => {
      await result.current.send("hello");
    });

    const messages = result.current.messages;
    const tools = result.current.tools;
    const send = result.current.send;
    rerender();
    expect(result.current.messages).toBe(messages);
    expect(result.current.tools).toBe(tools);
    expect(result.current.send).toBe(send);
  });

  it("reflects live registry changes in tools and honors denyTools", async () => {
    tool("visible-tool", { description: "Visible", run: () => "ok" });
    tool("denied-tool", { description: "Denied", run: () => "no" });

    const { provider } = countingProvider();
    const { result } = renderHook(() =>
      useAgent({ provider, denyTools: ["denied-tool"] }),
    );

    await waitFor(() =>
      expect(result.current.tools.map((t) => t.name)).toContain("visible-tool"),
    );
    expect(result.current.tools.map((t) => t.name)).not.toContain(
      "denied-tool",
    );

    // A tool registered after mount shows up without a send().
    act(() => {
      tool("late-tool", { description: "Registered later", run: () => "hi" });
    });
    await waitFor(() =>
      expect(result.current.tools.map((t) => t.name)).toContain("late-tool"),
    );
  });
});
