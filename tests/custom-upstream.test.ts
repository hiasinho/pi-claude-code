import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverClaudeModels, runClaudeRequest } from "../src/claude-cli.ts";
import { claudeUpstreamUrl } from "../src/env.ts";

test("resolves and validates custom upstream URLs", () => {
  assert.equal(claudeUpstreamUrl({}), "https://api.anthropic.com");
  assert.equal(claudeUpstreamUrl({ ANTHROPIC_BASE_URL: "" }), "https://api.anthropic.com");
  assert.equal(claudeUpstreamUrl({ ANTHROPIC_BASE_URL: "https://proxy.example/base" }), "https://proxy.example/base");
  assert.equal(claudeUpstreamUrl({ ANTHROPIC_BASE_URL: "https://proxy.example" }, "http://localhost:1234"), "http://localhost:1234");
  for (const url of ["file:///tmp/api", "https://user:pass@example.com", "https://example.com?key=secret", "https://example.com#fragment"]) {
    assert.throws(() => claudeUpstreamUrl({ ANTHROPIC_BASE_URL: url }));
  }
});

test("discovery accepts a custom endpoint and worker traffic reaches it through the relay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-custom-upstream-"));
  const executable = join(root, "claude.mjs");
  const usage = { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const events = [
    { type: "message_start", message: { id: "custom", role: "assistant", content: [], usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "proxy reply" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
    { type: "message_stop" },
  ];
  const requests: string[] = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests.push(req.url!);
    assert.equal(req.headers.authorization, "Bearer test-only");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address() as { port: number };
  const endpoint = `http://127.0.0.1:${address.port}`;
  await writeFile(executable, `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth")) {
  console.log(JSON.stringify({loggedIn: true}));
  process.exit(0);
}
for await (const line of readline.createInterface({input: process.stdin})) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    if (process.env.ANTHROPIC_BASE_URL !== process.env.EXPECTED_UPSTREAM) throw new Error("wrong discovery endpoint");
    console.log(JSON.stringify({type: "control_response", response: {subtype: "success", request_id: frame.request_id, response: {models: [{value: "sonnet", displayName: "Sonnet", description: "test"}]}}}));
  }
  if (frame.type !== "user" || frame.shouldQuery === false) continue;
  if (process.env.ANTHROPIC_BASE_URL === process.env.EXPECTED_UPSTREAM) throw new Error("worker bypassed relay");
  const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {method: "POST", headers: {authorization: "Bearer test-only"}, body: JSON.stringify({messages: [frame.message]})});
  if (!res.ok) throw new Error("relay failed: " + res.status);
  await res.text();
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage: ${JSON.stringify(usage)}}));
}
`);
  await chmod(executable, 0o755);
  const env = { PI_CLAUDE_CODE_COMMAND: executable, ANTHROPIC_BASE_URL: endpoint, EXPECTED_UPSTREAM: endpoint };
  try {
    assert.equal((await discoverClaudeModels(env, undefined, 5000))[0]?.value, "sonnet");
    const input = {
      model: "sonnet", frames: [{ type: "user" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] } }],
      systemPrompt: "test", manifest: [], extraBody: {}, toolNames: new Set<string>(), env, timeoutMs: 5000,
    };
    const result = await runClaudeRequest(input);
    assert.equal(result.message.id, "custom");
    assert.equal(result.relay.upstreamRequests, 1);
    assert.deepEqual(requests, ["/v1/messages"]);
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
      await assert.rejects(runClaudeRequest({ ...input, env: { ...env, [name]: "test" } }), /refuses conflicting auth\/backend overrides/);
    }
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
