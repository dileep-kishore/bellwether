import { describe, expect, test } from "bun:test";
import { SENTINEL } from "./fixtures/mcp-echo/server.js";

const server = new URL("./fixtures/mcp-echo/server.js", import.meta.url).pathname;

// Sends newline-delimited JSON-RPC requests and collects one response per request id.
async function session(requests) {
  const proc = Bun.spawn(["node", server], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  for (const r of requests) proc.stdin.write(JSON.stringify(r) + "\n");
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

describe("mcp-echo", () => {
  test("initialize answers with the client's protocol version and a tools capability", async () => {
    const [r] = await session([init]);
    expect(r.id).toBe(1);
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe("bw-echo");
  });

  test("tools/list shows bw_echo", async () => {
    const rs = await session([init, initialized, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    expect(rs).toHaveLength(2);
    const list = rs.find((r) => r.id === 2);
    expect(list.result.tools.map((t) => t.name)).toEqual(["bw_echo"]);
    expect(list.result.tools[0].inputSchema.type).toBe("object");
  });

  test("tools/call bw_echo returns the sentinel", async () => {
    const rs = await session([
      init,
      initialized,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bw_echo", arguments: {} } },
    ]);
    const call = rs.find((r) => r.id === 3);
    expect(call.result.content[0].text).toContain(SENTINEL);
    expect(call.result.isError).toBeFalsy();
  });

  test("an unknown method is a JSON-RPC error and an unknown tool is a tool error", async () => {
    const rs = await session([
      init,
      { jsonrpc: "2.0", id: 4, method: "nope" },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "other", arguments: {} } },
    ]);
    expect(rs.find((r) => r.id === 4).error.code).toBe(-32601);
    expect(rs.find((r) => r.id === 5).result.isError).toBe(true);
  });
});
