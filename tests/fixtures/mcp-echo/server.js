#!/usr/bin/env node
// A stdio MCP server with one tool, bw_echo, that returns SENTINEL. No dependencies, so any node can run it.
// Messages are newline-delimited JSON-RPC 2.0, as the MCP stdio transport defines them.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const SENTINEL = "BW-ECHO-OK-7Q4Z";

const TOOL = {
  name: "bw_echo",
  description: "Returns a fixed sentinel string. Call it when asked to check the bw-echo server.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export function handle(msg) {
  if (msg.id === undefined) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "bw-echo", version: "0.1.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call":
      if (msg.params?.name !== TOOL.name) {
        return reply({ content: [{ type: "text", text: `unknown tool ${msg.params?.name}` }], isError: true });
      }
      return reply({ content: [{ type: "text", text: SENTINEL }] });
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      return;
    }
    const out = handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
}
