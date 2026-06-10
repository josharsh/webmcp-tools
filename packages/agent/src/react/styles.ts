/**
 * Widget stylesheet — injected once on first mount via
 * `document.adoptedStyleSheets` (constructable stylesheet), with a `<style
 * data-webmcp-agent>` element fallback for environments without it. All
 * classes are `.wma-` prefixed; theming via `--wma-*` custom properties on
 * `.wma-root` (light defaults, dark overrides for `data-theme="dark"` and
 * `prefers-color-scheme` when `data-theme="auto"`).
 */

const DARK_VARS = `
  --wma-bg: #18181b;
  --wma-surface: #26262b;
  --wma-fg: #f4f4f5;
  --wma-fg-muted: #a1a1aa;
  --wma-border: #3f3f46;
  --wma-tool-card-bg: #202024;
  --wma-tool-card-border: #3f3f46;
`;

export const WIDGET_CSS = `
.wma-root {
  --wma-accent: #4f46e5;
  --wma-bg: #ffffff;
  --wma-surface: #f4f4f5;
  --wma-fg: #18181b;
  --wma-fg-muted: #71717a;
  --wma-border: #e4e4e7;
  --wma-radius: 12px;
  --wma-font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --wma-z-index: 2147483000;
  --wma-offset-x: 20px;
  --wma-offset-y: 20px;
  --wma-panel-width: 380px;
  --wma-panel-height: 560px;
  --wma-focus-ring: 0 0 0 2px var(--wma-bg), 0 0 0 4px var(--wma-accent);
  --wma-tool-card-bg: #fafafa;
  --wma-tool-card-border: #e4e4e7;
  --wma-tool-running: #2563eb;
  --wma-tool-success: #16a34a;
  --wma-tool-error: #dc2626;
  --wma-tool-confirm: #d97706;

  position: fixed;
  z-index: var(--wma-z-index);
  display: flex;
  gap: 12px;
  font-family: var(--wma-font-family);
  font-size: 14px;
  line-height: 1.5;
  color: var(--wma-fg);
  text-align: left;
}
.wma-root *,
.wma-root *::before,
.wma-root *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  font: inherit;
  color: inherit;
}
.wma-root[data-theme="dark"] {${DARK_VARS}}
@media (prefers-color-scheme: dark) {
  .wma-root[data-theme="auto"] {${DARK_VARS}}
}

.wma-root[data-position="bottom-right"] {
  right: var(--wma-offset-x);
  bottom: var(--wma-offset-y);
  flex-direction: column-reverse;
  align-items: flex-end;
}
.wma-root[data-position="bottom-left"] {
  left: var(--wma-offset-x);
  bottom: var(--wma-offset-y);
  flex-direction: column-reverse;
  align-items: flex-start;
}
.wma-root[data-position="top-right"] {
  right: var(--wma-offset-x);
  top: var(--wma-offset-y);
  flex-direction: column;
  align-items: flex-end;
}
.wma-root[data-position="top-left"] {
  left: var(--wma-offset-x);
  top: var(--wma-offset-y);
  flex-direction: column;
  align-items: flex-start;
}

.wma-root :focus-visible {
  outline: none;
  box-shadow: var(--wma-focus-ring);
}

.wma-launcher {
  width: 52px;
  height: 52px;
  border: none;
  border-radius: 50%;
  background: var(--wma-accent);
  color: #ffffff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  transition: transform 120ms ease;
}
.wma-launcher:hover {
  transform: scale(1.05);
}
.wma-launcher svg {
  width: 24px;
  height: 24px;
}

.wma-panel {
  display: flex;
  flex-direction: column;
  width: var(--wma-panel-width);
  height: var(--wma-panel-height);
  max-width: calc(100vw - 2 * var(--wma-offset-x));
  max-height: calc(100vh - 2 * var(--wma-offset-y) - 64px);
  background: var(--wma-bg);
  border: 1px solid var(--wma-border);
  border-radius: var(--wma-radius);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
  overflow: hidden;
}

.wma-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--wma-border);
  background: var(--wma-surface);
}
.wma-title {
  font-weight: 600;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wma-pill {
  flex: 0 0 auto;
  margin-right: auto;
  padding: 2px 8px;
  border: 1px solid var(--wma-border);
  border-radius: 999px;
  font-size: 11px;
  color: var(--wma-fg-muted);
  background: var(--wma-bg);
  white-space: nowrap;
}
.wma-pill[data-kind="scripted"] {
  border-color: var(--wma-tool-confirm);
  color: var(--wma-tool-confirm);
}
.wma-close {
  border: none;
  background: transparent;
  cursor: pointer;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  font-size: 18px;
  line-height: 1;
  color: var(--wma-fg-muted);
}
.wma-close:hover {
  background: var(--wma-border);
}

.wma-log {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;
}

.wma-message {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wma-bubble {
  max-width: 88%;
  padding: 8px 12px;
  border-radius: var(--wma-radius);
  white-space: normal;
  overflow-wrap: break-word;
}
.wma-bubble p + p {
  margin-top: 8px;
}
.wma-bubble-user {
  align-self: flex-end;
  background: var(--wma-accent);
  color: #ffffff;
}
.wma-bubble-assistant {
  align-self: flex-start;
  background: var(--wma-surface);
}
.wma-notice {
  align-self: center;
  max-width: 92%;
  padding: 6px 10px;
  border: 1px dashed var(--wma-border);
  border-radius: 8px;
  font-size: 12px;
  color: var(--wma-fg-muted);
  text-align: center;
}
.wma-caret {
  display: inline-block;
  width: 7px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: currentColor;
  animation: wma-blink 1s steps(1) infinite;
}
@keyframes wma-blink {
  50% {
    opacity: 0;
  }
}

.wma-tool-card {
  align-self: stretch;
  border: 1px solid var(--wma-tool-card-border);
  border-radius: 10px;
  background: var(--wma-tool-card-bg);
  font-size: 13px;
  overflow: hidden;
}
.wma-tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.wma-tool-glyph {
  flex: 0 0 auto;
  width: 16px;
  text-align: center;
}
.wma-tool-glyph[data-state="success"] {
  color: var(--wma-tool-success);
}
.wma-tool-glyph[data-state="error"] {
  color: var(--wma-tool-error);
}
.wma-tool-glyph[data-state="denied"] {
  color: var(--wma-tool-error);
}
.wma-tool-glyph[data-state="awaiting-confirmation"],
.wma-tool-glyph[data-state="awaiting-approval"] {
  color: var(--wma-tool-confirm);
}
.wma-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--wma-tool-running);
  border-top-color: transparent;
  border-radius: 50%;
  animation: wma-spin 0.8s linear infinite;
}
@keyframes wma-spin {
  to {
    transform: rotate(360deg);
  }
}
.wma-tool-title {
  font-weight: 600;
  white-space: nowrap;
}
.wma-tool-args {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--wma-fg-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.wma-badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.wma-badge-writes {
  background: var(--wma-tool-confirm);
  color: #ffffff;
}
.wma-badge-untrusted {
  background: var(--wma-tool-error);
  color: #ffffff;
}
.wma-tool-elapsed {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--wma-fg-muted);
  font-variant-numeric: tabular-nums;
}
.wma-chevron {
  flex: 0 0 auto;
  color: var(--wma-fg-muted);
  transition: transform 120ms ease;
}
.wma-chevron[data-expanded="true"] {
  transform: rotate(90deg);
}
.wma-tool-wait,
.wma-tool-denied {
  padding: 0 10px 8px 34px;
  font-size: 12px;
}
.wma-tool-wait {
  color: var(--wma-tool-confirm);
}
.wma-tool-denied {
  color: var(--wma-tool-error);
}
.wma-tool-detail {
  border-top: 1px solid var(--wma-tool-card-border);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wma-pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  max-height: 240px;
  overflow-y: auto;
}
.wma-tool-result[data-error="true"] .wma-pre {
  color: var(--wma-tool-error);
}
.wma-quoted {
  border-left: 3px solid var(--wma-tool-error);
  padding-left: 8px;
}
.wma-show-more {
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--wma-accent);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 0;
}

.wma-approval {
  align-self: stretch;
  border: 1px solid var(--wma-tool-confirm);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  background: var(--wma-tool-card-bg);
}
.wma-approval-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.wma-btn {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--wma-border);
  background: var(--wma-surface);
  cursor: pointer;
  font-size: 13px;
}
.wma-btn-approve {
  background: var(--wma-accent);
  border-color: var(--wma-accent);
  color: #ffffff;
}

.wma-empty {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 2px;
}
.wma-greeting {
  color: var(--wma-fg-muted);
}
.wma-tools-disclosure summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--wma-fg-muted);
}
.wma-tools-disclosure ul {
  margin-top: 6px;
  padding-left: 18px;
  font-size: 12px;
  color: var(--wma-fg-muted);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wma-tools-disclosure code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.wma-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.wma-chip {
  border: 1px solid var(--wma-border);
  border-radius: 999px;
  background: var(--wma-surface);
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.wma-chip:hover {
  border-color: var(--wma-accent);
  color: var(--wma-accent);
}

.wma-jump {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 74px;
  z-index: 1;
  border: 1px solid var(--wma-border);
  border-radius: 999px;
  background: var(--wma-bg);
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.wma-composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--wma-border);
  background: var(--wma-bg);
}
.wma-input {
  flex: 1;
  resize: none;
  border: 1px solid var(--wma-border);
  border-radius: 10px;
  background: var(--wma-bg);
  padding: 8px 10px;
  /* 16px prevents iOS Safari from zooming the page on focus. */
  font-size: 16px;
  line-height: 1.4;
  max-height: 120px;
}
.wma-send {
  flex: 0 0 auto;
  border: none;
  border-radius: 10px;
  background: var(--wma-accent);
  color: #ffffff;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}
.wma-send[data-busy="true"] {
  background: var(--wma-tool-error);
}

.wma-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 480px) {
  .wma-root[data-open="true"] {
    inset: 0;
    align-items: stretch;
  }
  .wma-root[data-open="true"] .wma-launcher {
    display: none;
  }
  .wma-root[data-open="true"] .wma-panel {
    width: 100%;
    max-width: none;
    height: 100dvh;
    max-height: none;
    border-radius: 0;
    border: none;
    padding-bottom: env(safe-area-inset-bottom);
  }
}

@media (prefers-reduced-motion: reduce) {
  .wma-root *,
  .wma-root *::before,
  .wma-root *::after {
    animation: none !important;
    transition: none !important;
  }
  .wma-caret {
    display: none;
  }
  .wma-spinner {
    border-top-color: var(--wma-tool-running);
  }
}
`;

let injected = false;

/** Inject the widget stylesheet once per document. Safe to call repeatedly. */
export function injectWidgetStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(WIDGET_CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    // Constructable stylesheets unavailable: fall back to a <style> element.
    const style = document.createElement("style");
    style.setAttribute("data-webmcp-agent", "");
    style.textContent = WIDGET_CSS;
    document.head.appendChild(style);
  }
}
