import { existsSync } from "node:fs";
import { defineConfig } from "tsup";

// "./react" and "./server" subpath sources land as separate modules; filter
// missing entries so the scaffold builds green before they exist and picks
// them up automatically once they do.
const entry = Object.fromEntries(
  Object.entries({
    index: "src/index.ts",
    react: "src/react/index.ts",
    server: "src/server/index.ts",
  }).filter(([, file]) => existsSync(file)),
);

export default defineConfig({
  entry,
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom", /^webmcp-tools($|\/)/],
});
