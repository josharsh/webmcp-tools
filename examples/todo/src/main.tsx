// Enable Zod -> JSON Schema descriptor generation. Import once, anywhere.
import "webmcp-tools/zod";

import React from "react";
import { createRoot } from "react-dom/client";
import {
  createWebMCPServer,
  PostMessageServerTransport,
} from "@josharsh/webmcp-bridge";
import App from "./App";
import "./styles.css";

/**
 * MCP bridge flag.
 *
 * When `true`, this page exposes its WebMCP tools as a real MCP server over
 * `postMessage`, so an out-of-page agent (a browser extension content script,
 * or an agent running in an iframe / parent frame) can connect with an MCP
 * client and call the same tools you see in the "Agent Tools" panel.
 *
 * It is off by default because the in-page "Simulate agent call" panel
 * already demonstrates the full flow with zero external setup. Flip it on
 * when you have an extension or embedding agent to talk to, and widen
 * `allowedOrigins` to include that agent's origin (never use "*" in
 * production — see the Security section of the root README).
 */
const ENABLE_MCP_BRIDGE: boolean = false;

if (ENABLE_MCP_BRIDGE) {
  const bridge = createWebMCPServer({
    name: "webmcp-tools-example-todo",
    version: "0.1.0",
  });
  void bridge.connect(
    new PostMessageServerTransport({
      allowedOrigins: [window.location.origin],
    }),
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
