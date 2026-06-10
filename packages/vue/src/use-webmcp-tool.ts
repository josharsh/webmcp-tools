import {
  getCurrentInstance,
  getCurrentScope,
  onMounted,
  onScopeDispose,
  onUnmounted,
  shallowRef,
  toValue,
  watch,
} from "vue";
import type { MaybeRefOrGetter, ShallowRef } from "vue";
import {
  autoRegisterForms,
  getRegisteredTools,
  onRegistryChange,
  tool,
} from "webmcp-tools";
import type { RegisteredTool, ToolDefinition, ToolInput } from "webmcp-tools";

/**
 * Register a WebMCP tool tied to the component lifecycle.
 *
 * - Registers via `tool()` in `onMounted` (or immediately when called outside
 *   a component, e.g. inside an `effectScope`).
 * - Unregisters in `onUnmounted` (or on scope dispose).
 * - If `name` is a ref/getter, the tool is re-registered when it changes.
 * - `run`/`confirm` are routed through the latest definition, so callbacks
 *   always see current reactive state — pass a getter when the definition is
 *   rebuilt from reactive values.
 */
export function useWebMCPTool<I extends ToolInput | undefined = undefined>(
  name: MaybeRefOrGetter<string>,
  definition: ToolDefinition<I> | (() => ToolDefinition<I>),
): ShallowRef<RegisteredTool | null> {
  const registered = shallowRef<RegisteredTool | null>(null);

  const getDefinition = (): ToolDefinition<I> =>
    typeof definition === "function" ? definition() : definition;

  const register = (toolName: string) => {
    const def = getDefinition();
    // Route execution through the *latest* definition so closures created on
    // later renders (getter form) and current reactive state are honored.
    const wrapped: ToolDefinition<I> = {
      ...def,
      run: (args, ctx) => getDefinition().run(args, ctx),
    };
    if (def.confirm !== undefined) {
      wrapped.confirm = (args) => {
        const latest = getDefinition().confirm;
        if (latest === undefined) return false;
        return typeof latest === "function" ? latest(args) : latest;
      };
    }
    registered.value = tool(toolName, wrapped);
  };

  const start = () => register(toValue(name));
  const stop = () => {
    registered.value?.unregister();
    registered.value = null;
  };

  if (getCurrentInstance()) {
    onMounted(start);
    onUnmounted(stop);
  } else {
    start();
    if (getCurrentScope()) onScopeDispose(stop);
  }

  watch(
    () => toValue(name),
    (newName) => {
      // Only re-register while active; pre-mount changes are picked up by
      // `onMounted` reading the latest name.
      if (!registered.value) return;
      registered.value.unregister();
      register(newName);
    },
  );

  return registered;
}

/**
 * Run `autoRegisterForms` (declarative `form[toolname]` tools) for the
 * component's lifetime. Pass `root` to scope observation to an element ref;
 * defaults to `document`.
 */
export function useWebMCPForms(
  root?: MaybeRefOrGetter<HTMLElement | undefined>,
): void {
  let cleanup: (() => void) | null = null;

  const start = () => {
    cleanup?.();
    cleanup = autoRegisterForms(toValue(root) ?? document);
  };
  const stop = () => {
    cleanup?.();
    cleanup = null;
  };

  if (getCurrentInstance()) {
    onMounted(start);
    onUnmounted(stop);
  } else {
    start();
    if (getCurrentScope()) onScopeDispose(stop);
  }

  watch(
    () => toValue(root),
    () => {
      // Re-scope only when already started (root element ref changed).
      if (cleanup) start();
    },
  );
}

/**
 * Reactive list of all tools currently registered through webmcp-tools.
 * Updates on every register/unregister event.
 */
export function useRegisteredTools(): ShallowRef<RegisteredTool[]> {
  const tools = shallowRef<RegisteredTool[]>(getRegisteredTools());
  const unsubscribe = onRegistryChange(() => {
    tools.value = getRegisteredTools();
  });
  if (getCurrentScope()) onScopeDispose(unsubscribe);
  return tools;
}
