import { afterEach, describe, expect, it } from "vitest";
import * as v from "valibot";
import "./valibot.js";
import { getRegisteredTools } from "./registry.js";
import { configure, tool } from "./tool.js";

afterEach(() => {
  for (const t of getRegisteredTools()) t.unregister();
  delete (document as { modelContext?: unknown }).modelContext;
  configure({ missingHost: "ponyfill", confirmHandler: () => false });
});

describe("Valibot adapter", () => {
  it("derives JSON Schema descriptors from Valibot input schemas", async () => {
    const t = tool("reserve-seat", {
      description: "Reserve a seat",
      input: v.object({
        seat: v.pipe(v.string(), v.minLength(1)),
        partySize: v.pipe(v.number(), v.integer(), v.minValue(1)),
        notes: v.optional(v.string()),
      }),
      run: (args) => args,
    });
    await t.ready;

    expect(t.descriptor.inputSchema).toMatchObject({
      type: "object",
      properties: {
        seat: { type: "string", minLength: 1 },
        partySize: { type: "integer", minimum: 1 },
        notes: { type: "string" },
      },
      required: ["seat", "partySize"],
    });
  });

  it("keeps Valibot validation in the tool execution path", async () => {
    const t = tool("score", {
      description: "Score an item",
      input: v.object({
        id: v.string(),
        score: v.pipe(v.number(), v.minValue(0)),
      }),
      run: (args) => ({ accepted: args.id }),
    });

    await expect(t.execute({ id: "a", score: 1 })).resolves.toMatchObject({
      structuredContent: { accepted: "a" },
    });

    await expect(t.execute({ id: "a", score: -1 })).resolves.toMatchObject({
      isError: true,
    });
  });
});
