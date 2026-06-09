# @webmcp-kit/vue

Vue 3 composables for [webmcp-kit](https://github.com/josharsh/webmcp-kit). Register WebMCP tools (`document.modelContext`) tied to component lifecycle: mounted → registered, unmounted → unregistered.

## Install

```sh
pnpm add @webmcp-kit/vue webmcp-kit
```

## Usage

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useWebMCPTool } from "@webmcp-kit/vue";

const cart = ref<string[]>([]);

useWebMCPTool("add-to-cart", {
  description: "Add a product SKU to the shopping cart",
  input: {
    type: "object",
    properties: { sku: { type: "string" } },
    required: ["sku"],
  },
  run: ({ sku }) => {
    cart.value = [...cart.value, sku as string];
    return `Cart now has ${cart.value.length} items`;
  },
});
</script>
```

Reactive name + definition getter (callbacks always see latest state):

```ts
const tab = ref("inbox");
useWebMCPTool(
  () => `read-${tab.value}`,
  () => ({
    description: `Read the ${tab.value} tab`,
    run: () => contents.value[tab.value],
  }),
);
```

## API

| Export               | Signature                                                                                                                      | Description                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useWebMCPTool`      | `(name: MaybeRefOrGetter<string>, definition: ToolDefinition \| (() => ToolDefinition)) => ShallowRef<RegisteredTool \| null>` | Registers in `onMounted` (immediately outside components), unregisters in `onUnmounted`/scope dispose. Re-registers when a reactive `name` changes. `run`/`confirm` are routed through the latest definition. |
| `useWebMCPForms`     | `(root?: MaybeRefOrGetter<HTMLElement \| undefined>) => void`                                                                  | Runs `autoRegisterForms` (declarative `form[toolname]` tools) for the component's lifetime. Defaults to `document`.                                                                                           |
| `useRegisteredTools` | `() => ShallowRef<RegisteredTool[]>`                                                                                           | Reactive list of all tools registered through webmcp-kit.                                                                                                                                                     |

MIT
