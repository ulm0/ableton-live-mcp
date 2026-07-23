import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { startServer } from "./server.js";

export function activate(activation: ActivationContext): void {
  const context = initialize(activation, "1.0.0");
  startServer(context, activation.hostApiVersion).catch((e) => {
    console.error("[ableton-live-mcp] failed to start MCP server:", e);
  });
}
