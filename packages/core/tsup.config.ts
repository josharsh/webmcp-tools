import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    zod: "src/zod.ts",
    valibot: "src/valibot.ts",
    ponyfill: "src/ponyfill.ts",
    devtools: "src/devtools.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^zod($|\/)/, "valibot", "@valibot/to-json-schema"],
});
