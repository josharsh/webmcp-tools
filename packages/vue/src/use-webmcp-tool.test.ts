import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, effectScope, h, nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import { getRegisteredTool, getRegisteredTools } from "webmcp-kit";
import {
  useRegisteredTools,
  useWebMCPForms,
  useWebMCPTool,
} from "./use-webmcp-tool.js";

afterEach(() => {
  // Tests must not leak tools into each other.
  for (const t of getRegisteredTools()) t.unregister();
});

describe("useWebMCPTool", () => {
  it("registers on mount and unregisters on unmount", () => {
    const wrapper = mount(
      defineComponent({
        setup() {
          useWebMCPTool("greet", {
            description: "Say hello",
            run: () => "hello",
          });
          return () => h("div");
        },
      }),
    );

    expect(getRegisteredTool("greet")).toBeDefined();
    wrapper.unmount();
    expect(getRegisteredTool("greet")).toBeUndefined();
  });

  it("returns a shallowRef that holds the RegisteredTool handle", async () => {
    let handle: ReturnType<typeof useWebMCPTool> | undefined;
    const wrapper = mount(
      defineComponent({
        setup() {
          handle = useWebMCPTool("handled", {
            description: "Handle test",
            run: () => "ok",
          });
          return () => h("div");
        },
      }),
    );

    expect(handle!.value).not.toBeNull();
    expect(handle!.value!.name).toBe("handled");
    const result = await handle!.value!.execute({});
    expect(result.content[0]!.text).toBe("ok");
    wrapper.unmount();
    expect(handle!.value).toBeNull();
  });

  it("registers immediately when called outside a component and unregisters on scope dispose", () => {
    const scope = effectScope();
    scope.run(() => {
      useWebMCPTool("scoped", {
        description: "Scoped tool",
        run: () => "ok",
      });
    });
    expect(getRegisteredTool("scoped")).toBeDefined();
    scope.stop();
    expect(getRegisteredTool("scoped")).toBeUndefined();
  });

  it("re-registers when a reactive name changes", async () => {
    const name = ref("first-name");
    const wrapper = mount(
      defineComponent({
        setup() {
          useWebMCPTool(name, {
            description: "Renamable",
            run: () => "ok",
          });
          return () => h("div");
        },
      }),
    );

    expect(getRegisteredTool("first-name")).toBeDefined();
    name.value = "second-name";
    await nextTick();
    expect(getRegisteredTool("first-name")).toBeUndefined();
    expect(getRegisteredTool("second-name")).toBeDefined();

    wrapper.unmount();
    expect(getRegisteredTool("second-name")).toBeUndefined();
  });

  it("run sees the latest reactive state (object definition)", async () => {
    const count = ref(0);
    mount(
      defineComponent({
        setup() {
          useWebMCPTool("counter", {
            description: "Read the counter",
            run: () => `count is ${count.value}`,
          });
          return () => h("div");
        },
      }),
    );

    count.value = 7;
    const result = await getRegisteredTool("counter")!.execute({});
    expect(result.content[0]!.text).toBe("count is 7");
  });

  it("run is routed through the latest definition (getter form)", async () => {
    const mode = ref("a");
    mount(
      defineComponent({
        setup() {
          useWebMCPTool("modal", () => ({
            description: `Mode ${mode.value}`,
            run: () => `ran in mode ${mode.value}`,
          }));
          return () => h("div");
        },
      }),
    );

    mode.value = "b";
    const result = await getRegisteredTool("modal")!.execute({});
    expect(result.content[0]!.text).toBe("ran in mode b");
  });

  it("rejects invalid input via the registered tool (validation failure path)", async () => {
    mount(
      defineComponent({
        setup() {
          useWebMCPTool("strict", {
            description: "Needs a qty",
            input: {
              type: "object",
              properties: { qty: { type: "number" } },
              required: ["qty"],
            },
            run: (args) => `got ${(args as { qty: number }).qty}`,
          });
          return () => h("div");
        },
      }),
    );

    const bad = await getRegisteredTool("strict")!.execute({});
    expect(bad.isError).toBe(true);

    const good = await getRegisteredTool("strict")!.execute({ qty: 3 });
    expect(good.isError).toBeUndefined();
    expect(good.content[0]!.text).toBe("got 3");
  });

  it("confirm gate consults the latest definition and can deny", async () => {
    const requireConfirm = ref(false);
    let denied = false;
    mount(
      defineComponent({
        setup() {
          useWebMCPTool("guarded", () => ({
            description: "Guarded action",
            confirm: requireConfirm.value && "Really?",
            run: () => "did it",
          }));
          return () => h("div");
        },
      }),
    );

    // confirm: false → runs without asking.
    const open = await getRegisteredTool("guarded")!.execute({});
    expect(open.content[0]!.text).toBe("did it");

    // Flip reactive state; happy-dom window.confirm is not interactive, so
    // kit's default handler denies → tool must NOT run.
    const originalConfirm = window.confirm;
    window.confirm = () => {
      denied = true;
      return false;
    };
    requireConfirm.value = true;
    const blocked = await getRegisteredTool("guarded")!.execute({});
    window.confirm = originalConfirm;

    expect(denied).toBe(true);
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]!.text).toContain("declined");
  });

  it("executing after unmount returns an error result, not a crash", async () => {
    let handle: ReturnType<typeof useWebMCPTool> | undefined;
    const wrapper = mount(
      defineComponent({
        setup() {
          handle = useWebMCPTool("ghost", {
            description: "Will be unmounted",
            run: () => "alive",
          });
          return () => h("div");
        },
      }),
    );
    const tool = handle!.value!;
    wrapper.unmount();
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
  });
});

describe("useRegisteredTools", () => {
  it("tracks register and unregister events reactively", () => {
    let list: ReturnType<typeof useRegisteredTools> | undefined;
    const scope = effectScope();
    scope.run(() => {
      list = useRegisteredTools();
    });
    expect(list!.value).toHaveLength(0);

    const wrapper = mount(
      defineComponent({
        setup() {
          useWebMCPTool("listed", {
            description: "Shows up in the list",
            run: () => "ok",
          });
          return () => h("div");
        },
      }),
    );

    expect(list!.value.map((t) => t.name)).toContain("listed");
    wrapper.unmount();
    expect(list!.value).toHaveLength(0);

    // After scope disposal the listener is gone — list stops updating.
    scope.stop();
    mount(
      defineComponent({
        setup() {
          useWebMCPTool("after-dispose", {
            description: "Registered after scope stop",
            run: () => "ok",
          });
          return () => h("div");
        },
      }),
    );
    expect(list!.value).toHaveLength(0);
  });
});

describe("useWebMCPForms", () => {
  it("registers form[toolname] tools on mount and cleans up on unmount", async () => {
    const wrapper = mount(
      defineComponent({
        setup() {
          useWebMCPForms();
          return () =>
            h(
              "form",
              { toolname: "subscribe", tooldescription: "Subscribe form" },
              [h("input", { name: "email", type: "email" })],
            );
        },
      }),
      { attachTo: document.body },
    );

    // autoRegisterForms scans synchronously in onMounted.
    expect(getRegisteredTool("subscribe")).toBeDefined();
    wrapper.unmount();
    await nextTick();
    expect(getRegisteredTool("subscribe")).toBeUndefined();
  });
});
