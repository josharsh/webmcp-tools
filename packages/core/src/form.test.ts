import { afterEach, describe, expect, it, vi } from "vitest";
import { autoRegisterForms, formTool } from "./form.js";
import { configure } from "./tool.js";
import { getRegisteredTool, getRegisteredTools } from "./registry.js";

function makeForm(
  html: string,
  attrs: Record<string, string> = {},
  parent: ParentNode = document.body,
): HTMLFormElement {
  const form = document.createElement("form");
  for (const [k, v] of Object.entries(attrs)) form.setAttribute(k, v);
  form.innerHTML = html;
  parent.appendChild(form as Node & HTMLFormElement);
  return form;
}

/** Wait until `cond` is true or the timeout passes (MutationObserver is async). */
async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(() => {
  for (const t of getRegisteredTools()) t.unregister();
  delete (document as { modelContext?: unknown }).modelContext;
  document.body.innerHTML = "";
  configure({ missingHost: "ponyfill", confirmHandler: () => false });
  vi.restoreAllMocks();
});

describe("formTool schema synthesis", () => {
  it("derives a JSON Schema from the form's fields", () => {
    const form = makeForm(
      `
      <input name="title" required>
      <input type="number" name="qty" min="1" max="10">
      <input type="checkbox" name="gift" required>
      <select name="size" required>
        <option value="">--</option>
        <option value="s">S</option>
        <option value="m">M</option>
      </select>
      <textarea name="notes"></textarea>
      <input type="email" name="email">
      <input type="hidden" name="secret" value="x">
      <input type="submit" name="go">
      `,
      { toolname: "order", tooldescription: "Place an order" },
    );
    const t = formTool(form);
    const schema = t.descriptor.inputSchema as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };

    expect(schema.type).toBe("object");
    expect(schema.properties.title).toEqual({ type: "string" });
    expect(schema.properties.qty).toEqual({
      type: "number",
      minimum: 1,
      maximum: 10,
    });
    expect(schema.properties.gift).toEqual({ type: "boolean" });
    expect(schema.properties.size).toEqual({
      type: "string",
      enum: ["s", "m"],
    });
    expect(schema.properties.notes).toEqual({ type: "string" });
    expect(schema.properties.email).toEqual({
      type: "string",
      format: "email",
    });
    // submit/hidden inputs are skipped entirely
    expect(schema.properties.secret).toBeUndefined();
    expect(schema.properties.go).toBeUndefined();
    // checkboxes are never required, even with the attribute
    expect(schema.required).toEqual(["title", "size"]);
  });

  it("uses toolparamdescription attributes on fields as property descriptions", () => {
    const form = makeForm(
      `<input name="city" toolparamdescription="Destination city">`,
      { toolname: "search", tooldescription: "Search trips" },
    );
    const t = formTool(form);
    const schema = t.descriptor.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.city).toEqual({
      type: "string",
      description: "Destination city",
    });
  });

  it("falls back to tooldescription on fields (back-compat), spec attribute wins", () => {
    const form = makeForm(
      `
      <input name="legacy" tooldescription="Legacy description">
      <input name="both" toolparamdescription="Spec wins" tooldescription="Legacy loses">
      `,
      { toolname: "compat", tooldescription: "d" },
    );
    const t = formTool(form);
    const schema = t.descriptor.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.legacy!.description).toBe("Legacy description");
    expect(schema.properties.both!.description).toBe("Spec wins");
  });

  it("throws when the form has no toolname and no options.name", () => {
    const form = makeForm(`<input name="a">`, { tooldescription: "d" });
    expect(() => formTool(form)).toThrow(/toolname/);
  });

  it("throws when there is no description", () => {
    const form = makeForm(`<input name="a">`, { toolname: "no-desc" });
    expect(() => formTool(form)).toThrow(/tooldescription/);
  });

  it("options.name/options.description override the attributes", () => {
    const form = makeForm(`<input name="a">`, {
      toolname: "attr-name",
      tooldescription: "attr-desc",
    });
    const t = formTool(form, { name: "opt-name", description: "opt-desc" });
    expect(t.name).toBe("opt-name");
    expect(t.descriptor.description).toBe("opt-desc");
  });
});

describe("formTool execution", () => {
  it("fills fields, dispatches input+change, and calls requestSubmit (toolautosubmit)", async () => {
    const form = makeForm(
      `
      <input name="title" required>
      <input type="checkbox" name="gift">
      <select name="size">
        <option value="s">S</option>
        <option value="m">M</option>
      </select>
      `,
      {
        toolname: "fill",
        tooldescription: "Fill the form",
        toolautosubmit: "",
      },
    );
    // happy-dom's requestSubmit would actually submit; spy it out either way.
    const requestSubmit = vi.fn();
    (form as { requestSubmit: () => void }).requestSubmit = requestSubmit;
    const inputEvents = vi.fn();
    const changeEvents = vi.fn();
    form.addEventListener("input", inputEvents);
    form.addEventListener("change", changeEvents);

    const t = formTool(form);
    const result = await t.execute({ title: "Hat", gift: true, size: "m" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('Submitted form "fill".');
    expect((form.elements.namedItem("title") as HTMLInputElement).value).toBe(
      "Hat",
    );
    expect((form.elements.namedItem("gift") as HTMLInputElement).checked).toBe(
      true,
    );
    expect((form.elements.namedItem("size") as HTMLSelectElement).value).toBe(
      "m",
    );
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    // input + change bubbled for each of the 3 filled fields
    expect(inputEvents).toHaveBeenCalledTimes(3);
    expect(changeEvents).toHaveBeenCalledTimes(3);
  });

  it("without toolautosubmit: fills, focuses the submit control, does NOT submit", async () => {
    const form = makeForm(
      `<input name="title"><button type="submit">Go</button>`,
      { toolname: "review-me", tooldescription: "d" },
    );
    const requestSubmit = vi.fn();
    (form as { requestSubmit: () => void }).requestSubmit = requestSubmit;
    const submitButton = form.querySelector("button")!;
    const focus = vi.fn();
    (submitButton as { focus: () => void }).focus = focus;

    const t = formTool(form);
    const result = await t.execute({ title: "Hat" });

    expect(requestSubmit).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
    expect((form.elements.namedItem("title") as HTMLInputElement).value).toBe(
      "Hat",
    );
    expect(result.content[0]!.text).toBe(
      'Filled form "review-me". Awaiting user review — the user must ' +
        "submit manually.",
    );
  });

  it("options.autoSubmit: true submits without the attribute; false wins over it", async () => {
    const noAttr = makeForm(`<input name="a">`, {
      toolname: "opt-submit",
      tooldescription: "d",
    });
    const submitNoAttr = vi.fn();
    (noAttr as { requestSubmit: () => void }).requestSubmit = submitNoAttr;
    const t1 = formTool(noAttr, { autoSubmit: true });
    const r1 = await t1.execute({ a: "x" });
    expect(submitNoAttr).toHaveBeenCalledTimes(1);
    expect(r1.content[0]!.text).toBe('Submitted form "opt-submit".');

    const withAttr = makeForm(`<input name="a">`, {
      toolname: "opt-no-submit",
      tooldescription: "d",
      toolautosubmit: "",
    });
    const submitWithAttr = vi.fn();
    (withAttr as { requestSubmit: () => void }).requestSubmit = submitWithAttr;
    const t2 = formTool(withAttr, { autoSubmit: false });
    const r2 = await t2.execute({ a: "x" });
    expect(submitWithAttr).not.toHaveBeenCalled();
    expect(r2.content[0]!.text).toMatch(/Awaiting user review/);
  });

  it("rejects input that violates the synthesized schema", async () => {
    const form = makeForm(`<input name="title" required>`, {
      toolname: "strict-form",
      tooldescription: "d",
    });
    const requestSubmit = vi.fn();
    (form as { requestSubmit: () => void }).requestSubmit = requestSubmit;
    const t = formTool(form);

    const result = await t.execute({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(
      /missing required property "title"/,
    );
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("onSubmit overrides requestSubmit and its return value is the result", async () => {
    const form = makeForm(`<input name="q">`, {
      toolname: "searcher",
      tooldescription: "d",
    });
    const requestSubmit = vi.fn();
    (form as { requestSubmit: () => void }).requestSubmit = requestSubmit;
    const onSubmit = vi.fn(() => ({ results: 3 }));

    const t = formTool(form, { onSubmit });
    const result = await t.execute({ q: "hats" });

    expect(onSubmit).toHaveBeenCalledWith(form);
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({ results: 3 });
  });

  it("wires the confirm option through to the confirm handler", async () => {
    const handler = vi.fn(() => false);
    configure({ confirmHandler: handler });
    const form = makeForm(`<input name="q">`, {
      toolname: "confirmed",
      tooldescription: "d",
    });
    const requestSubmit = vi.fn();
    (form as { requestSubmit: () => void }).requestSubmit = requestSubmit;

    const t = formTool(form, { confirm: "Really submit?" });
    const result = await t.execute({ q: "x" });

    expect(handler).toHaveBeenCalledWith("Really submit?", "confirmed", {
      q: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      'User declined to run tool "confirmed".',
    );
    expect(requestSubmit).not.toHaveBeenCalled();
  });
});

describe("autoRegisterForms", () => {
  it("registers existing form[toolname] elements", () => {
    makeForm(`<input name="a">`, {
      toolname: "existing",
      tooldescription: "d",
    });
    const cleanup = autoRegisterForms();
    expect(getRegisteredTool("existing")).toBeDefined();
    cleanup();
  });

  it("skips (with a warning) forms missing a description, without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    makeForm(`<input name="a">`, { toolname: "broken-form" });
    const cleanup = autoRegisterForms();
    expect(getRegisteredTool("broken-form")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    cleanup();
  });

  it("registers forms added later, including nested ones", async () => {
    const cleanup = autoRegisterForms();
    expect(getRegisteredTools()).toHaveLength(0);

    // Direct form node added
    makeForm(`<input name="a">`, {
      toolname: "added-direct",
      tooldescription: "d",
    });
    // Form nested inside an added wrapper
    const wrapper = document.createElement("div");
    makeForm(
      `<input name="b">`,
      {
        toolname: "added-nested",
        tooldescription: "d",
      },
      wrapper,
    );
    document.body.appendChild(wrapper);

    await waitFor(() =>
      Boolean(
        getRegisteredTool("added-direct") && getRegisteredTool("added-nested"),
      ),
    );
    expect(getRegisteredTool("added-direct")).toBeDefined();
    expect(getRegisteredTool("added-nested")).toBeDefined();
    cleanup();
  });

  it("unregisters forms that are removed from the DOM", async () => {
    const form = makeForm(`<input name="a">`, {
      toolname: "removable",
      tooldescription: "d",
    });
    const cleanup = autoRegisterForms();
    expect(getRegisteredTool("removable")).toBeDefined();

    // happy-dom 15's HTMLFormElement.remove() throws (proxy identity bug);
    // removeChild produces the same removedNodes mutation record.
    document.body.removeChild(form);
    await waitFor(() => getRegisteredTool("removable") === undefined);
    expect(getRegisteredTool("removable")).toBeUndefined();
    cleanup();
  });

  it("unregisters forms removed inside a wrapper element", async () => {
    const wrapper = document.createElement("div");
    makeForm(
      `<input name="a">`,
      { toolname: "wrapped-removable", tooldescription: "d" },
      wrapper,
    );
    document.body.appendChild(wrapper);
    const cleanup = autoRegisterForms();
    expect(getRegisteredTool("wrapped-removable")).toBeDefined();

    wrapper.remove();
    await waitFor(() => getRegisteredTool("wrapped-removable") === undefined);
    expect(getRegisteredTool("wrapped-removable")).toBeUndefined();
    cleanup();
  });

  it("re-registers a form when its toolname attribute changes", async () => {
    const form = makeForm(`<input name="a">`, {
      toolname: "old-name",
      tooldescription: "d",
    });
    const cleanup = autoRegisterForms();
    expect(getRegisteredTool("old-name")).toBeDefined();

    form.setAttribute("toolname", "new-name");
    await waitFor(() => getRegisteredTool("new-name") !== undefined);
    expect(getRegisteredTool("old-name")).toBeUndefined();
    expect(getRegisteredTool("new-name")).toBeDefined();
    cleanup();
  });

  it("re-registers with a fresh description when tooldescription changes", async () => {
    const form = makeForm(`<input name="a">`, {
      toolname: "redesc",
      tooldescription: "before",
    });
    const cleanup = autoRegisterForms();
    expect(getRegisteredTool("redesc")!.descriptor.description).toBe("before");

    form.setAttribute("tooldescription", "after");
    await waitFor(
      () => getRegisteredTool("redesc")?.descriptor.description === "after",
    );
    expect(getRegisteredTool("redesc")!.descriptor.description).toBe("after");
    cleanup();
  });

  it("removing toolname unregisters the form's tool", async () => {
    const form = makeForm(`<input name="a">`, {
      toolname: "to-remove",
      tooldescription: "d",
    });
    const cleanup = autoRegisterForms();
    expect(getRegisteredTool("to-remove")).toBeDefined();

    form.removeAttribute("toolname");
    await waitFor(() => getRegisteredTool("to-remove") === undefined);
    expect(getRegisteredTool("to-remove")).toBeUndefined();
    cleanup();
  });

  it("adding toolname to an existing form registers it", async () => {
    const form = makeForm(`<input name="a">`, { tooldescription: "d" });
    const cleanup = autoRegisterForms();
    expect(getRegisteredTools()).toHaveLength(0);

    form.setAttribute("toolname", "late-attr");
    await waitFor(() => getRegisteredTool("late-attr") !== undefined);
    expect(getRegisteredTool("late-attr")).toBeDefined();
    cleanup();
  });

  it("cleanup() unregisters everything and stops watching", async () => {
    makeForm(`<input name="a">`, {
      toolname: "cleanup-a",
      tooldescription: "d",
    });
    const cleanup = autoRegisterForms();
    expect(getRegisteredTool("cleanup-a")).toBeDefined();

    cleanup();
    expect(getRegisteredTool("cleanup-a")).toBeUndefined();
    expect(getRegisteredTools()).toHaveLength(0);

    // Observer is disconnected: new forms are no longer auto-registered.
    makeForm(`<input name="b">`, {
      toolname: "after-cleanup",
      tooldescription: "d",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(getRegisteredTool("after-cleanup")).toBeUndefined();
  });
});
