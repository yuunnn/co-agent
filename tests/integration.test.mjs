import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(projectRoot, "bin", "co-agent.mjs");

async function waitForRuntime(runtimePath) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const runtime = JSON.parse(await fs.readFile(runtimePath, "utf8"));
      const response = await fetch(`http://127.0.0.1:${runtime.port}/api/health`);
      if (response.ok) return runtime;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test daemon did not start");
}

test("daemon, MCP, and ACP form one working local control plane", async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "co-agent-test-"));
  const environment = { ...process.env, CO_AGENT_HOME: temporaryRoot };
  const daemon = spawn(process.execPath, [cliPath, "daemon"], { cwd: projectRoot, env: environment, stdio: ["ignore", "ignore", "pipe"] });
  t.after(async () => {
    daemon.kill("SIGTERM");
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  const runtime = await waitForRuntime(path.join(temporaryRoot, "runtime.json"));
  assert.equal((await fs.stat(path.join(temporaryRoot, "runtime.json"))).mode & 0o777, 0o600);
  const mockDesktop = path.join(temporaryRoot, "mock-desktop.mjs");
  await fs.writeFile(mockDesktop, `#!${process.execPath}
import fs from "node:fs/promises";
import path from "node:path";
const launchIndex = process.argv.indexOf("--launch-id");
const launchId = process.argv[launchIndex + 1];
const runtime = JSON.parse(await fs.readFile(path.join(process.env.CO_AGENT_HOME, "runtime.json"), "utf8"));
await fetch(\`http://127.0.0.1:\${runtime.port}/api/desktop/launches/\${launchId}/ready\`, {
  method: "POST",
  headers: { authorization: \`Bearer \${runtime.token}\`, "content-type": "application/json" },
  body: "{}",
});
`);
  await fs.chmod(mockDesktop, 0o700);
  environment.CO_AGENT_APP_BIN = mockDesktop;
  const request = async (pathname, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${pathname}`, {
      ...options,
      headers: { authorization: `Bearer ${runtime.token}`, "content-type": "application/json", ...(options.headers || {}) },
    });
    const body = await response.json();
    assert.equal(response.ok, true, body.error || pathname);
    return body;
  };
  const html = await fetch(`http://127.0.0.1:${runtime.port}/?token=${runtime.token}`).then((response) => response.text());
  assert.match(html, /Co-Agent Council/);
  const initialSessions = await fetch(`http://127.0.0.1:${runtime.port}/api/sessions`, {
    headers: { authorization: `Bearer ${runtime.token}` },
  }).then((response) => response.json());
  assert.deepEqual(initialSessions.sessions, [], "production starts without fake or standalone tasks");

  const initialConfig = await request("/api/config");
  assert.equal(initialConfig.config.appearance.theme, "co-agent-dark");
  assert.equal(initialConfig.config.version, 3);
  assert.deepEqual(initialConfig.config.agentProviders, [], "new installations start with user-managed terminal agents");
  assert.deepEqual(initialConfig.config.apiProviders, [], "new installations do not infer or add API providers");
  const themed = await request("/api/config/theme", { method: "POST", body: JSON.stringify({ theme: "gruvbox-dark" }) });
  assert.equal(themed.config.appearance.theme, "gruvbox-dark");

  const mockClaude = path.join(temporaryRoot, "claude");
  await fs.writeFile(mockClaude, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "mock-claude 1.0"
else
  echo '{"result":"CO_AGENT_AGENT_OK","modelUsage":{"mock-claude":{}},"session_id":"mock-session"}'
fi
`);
  await fs.chmod(mockClaude, 0o700);
  const configuredAgent = await request("/api/providers/agents", {
    method: "POST",
    body: JSON.stringify({ name: "User Claude", command: mockClaude, enabled: true }),
  });
  assert.equal(configuredAgent.result.response, "CO_AGENT_AGENT_OK");
  assert.equal(configuredAgent.provider.adapter, "claude-code");
  assert.equal(configuredAgent.provider.enabled, true);
  const inspectedAgents = await request("/api/providers/agents");
  assert.equal(inspectedAgents.providers[0].version, "mock-claude 1.0");
  const testedAgent = await request(`/api/providers/agents/${configuredAgent.provider.id}/test`, { method: "POST", body: "{}" });
  assert.equal(testedAgent.result.model, "mock-claude");

  const providerServer = http.createServer(async (providerRequest, providerResponse) => {
    const chunks = [];
    for await (const chunk of providerRequest) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    providerResponse.writeHead(200, { "content-type": "application/json" });
    providerResponse.end(JSON.stringify({ id: "test-completion", model: payload.model, choices: [{ message: { content: "CO_AGENT_API_OK" } }] }));
  });
  await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  t.after(() => providerServer.close());
  const providerPort = providerServer.address().port;
  const configured = await request("/api/providers/api", {
    method: "POST",
    body: JSON.stringify({ name: "Test Gateway", baseUrl: `http://127.0.0.1:${providerPort}/v1`, model: "test-model", token: "test-secret", enabled: true }),
  });
  assert.equal(configured.result.response, "CO_AGENT_API_OK");
  const provider = configured.config.apiProviders[0];
  assert.equal(provider.hasToken, true);
  assert.equal("token" in provider, false, "settings responses never return stored tokens");
  const configuredSecond = await request("/api/providers/api", {
    method: "POST",
    body: JSON.stringify({ name: "Second Gateway", baseUrl: `http://127.0.0.1:${providerPort}/v1`, model: "second-model", token: "second-secret", enabled: true }),
  });
  assert.deepEqual(configuredSecond.config.apiProviders.map((item) => item.enabled), [true, true], "API seats are independently enabled");
  const disabled = await request(`/api/providers/api/${provider.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: false }) });
  assert.equal(disabled.config.apiProviders.find((item) => item.id === provider.id).enabled, false);
  const enabledAgain = await request(`/api/providers/api/${provider.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: true }) });
  assert.equal(enabledAgain.result.response, "CO_AGENT_API_OK");
  const providerTest = await request(`/api/providers/api/${provider.id}/test`, { method: "POST", body: "{}" });
  assert.equal(providerTest.result.response, "CO_AGENT_API_OK");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp"],
    cwd: projectRoot,
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "co-agent-test", version: "0.1.1" });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    "co_agent_open",
    "co_agent_bind_current",
    "co_agent_get_session",
    "co_agent_record_output",
    "co_agent_publish_result",
    "co_agent_start_council_round",
  ]);
  const bound = await client.callTool({
    name: "co_agent_bind_current",
    arguments: { title: "Integration council", objective: "Verify protocol wiring", hostThreadId: "test-thread", evidenceMode: "prompt", openApp: true },
  });
  assert.equal(bound.structuredContent.controller.threadId, "test-thread");
  assert.equal(bound.structuredContent.opened, true, "binding only succeeds after the desktop UI reports ready");
  const sessionFile = path.join(temporaryRoot, "sessions", bound.structuredContent.sessionId, "session.json");
  const storedSession = JSON.parse(await fs.readFile(sessionFile, "utf8"));
  assert.equal(storedSession.title, "Integration council");
  assert.equal(storedSession.evidence.mode, "prompt");
  assert.equal(storedSession.participants[0].id, "codex");
  const terminalSeats = storedSession.participants.filter((participant) => participant.providerKind === "terminal-agent");
  assert.equal(terminalSeats.length, 1);
  assert.equal(terminalSeats[0].name, "User Claude");
  assert.equal(terminalSeats[0].command, mockClaude);
  const apiSeats = storedSession.participants.filter((participant) => participant.providerKind === "openai-compatible");
  assert.equal(apiSeats.length, 2);
  assert.deepEqual(apiSeats.map((participant) => participant.name), ["Test Gateway", "Second Gateway"]);
  assert.equal(apiSeats.every((participant) => participant.id.startsWith("api-provider:")), true);
  assert.equal(new Set(apiSeats.map((participant) => participant.id)).size, 2);

  const published = await client.callTool({
    name: "co_agent_publish_result",
    arguments: { sessionId: bound.structuredContent.sessionId, outcome: "Proceed", summary: "The council found a viable path.", actions: ["Implement the agreed path"], agreements: ["The evidence is sufficient"], finalized: true },
  });
  assert.equal(published.structuredContent.result.outcome, "Proceed");
  const storedResult = JSON.parse(await fs.readFile(sessionFile, "utf8"));
  assert.equal(storedResult.result.outcome, "Proceed");
  assert.equal(storedResult.phase, "result");

  const failingDesktop = path.join(temporaryRoot, "failing-desktop.sh");
  await fs.writeFile(failingDesktop, "#!/bin/sh\necho 'mock desktop failed' >&2\nexit 7\n");
  await fs.chmod(failingDesktop, 0o700);
  const failingTransport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp"],
    cwd: projectRoot,
    env: { ...environment, CO_AGENT_APP_BIN: failingDesktop },
    stderr: "pipe",
  });
  const failingClient = new Client({ name: "co-agent-launch-failure-test", version: "0.1.1" });
  await failingClient.connect(failingTransport);
  t.after(() => failingClient.close());
  const failedOpen = await failingClient.callTool({ name: "co_agent_open", arguments: {} });
  assert.equal(failedOpen.isError, true, "MCP must not report a crashed desktop process as opened");
  assert.match(failedOpen.content[0].text, /exited before its window became ready/);

  const acpChild = spawn(process.execPath, [cliPath, "acp"], { cwd: projectRoot, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => acpChild.kill("SIGTERM"));
  const stream = acp.ndJsonStream(Writable.toWeb(acpChild.stdin), Readable.toWeb(acpChild.stdout));
  const connection = new acp.ClientSideConnection(() => ({
    async requestPermission() { return { outcome: { outcome: "cancelled" } }; },
    async sessionUpdate() {},
    async readTextFile() { return { content: "" }; },
    async writeTextFile() { return {}; },
  }), stream);
  const initialized = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  assert.equal(initialized.protocolVersion, acp.PROTOCOL_VERSION);
  const acpSession = await connection.newSession({ cwd: projectRoot, mcpServers: [] });
  assert.match(acpSession.sessionId, /^[a-f0-9-]{36}$/);
  const acpStored = await request(`/api/sessions/${acpSession.sessionId}`);
  assert.equal(acpStored.session.title, "Experimental ACP bridge");
  assert.equal(acpStored.session.participants[0].seatState, "advisory");

  const archived = await request(`/api/sessions/${bound.structuredContent.sessionId}`, { method: "DELETE" });
  assert.equal(archived.archived.id, bound.structuredContent.sessionId);
  await request(`/api/sessions/${acpSession.sessionId}`, { method: "DELETE" });
  const visibleAfterArchive = await request("/api/sessions");
  assert.deepEqual(visibleAfterArchive.sessions, []);
  const archivedEntries = await fs.readdir(path.join(temporaryRoot, "archived-sessions"));
  assert.equal(archivedEntries.length, 2, "remove is recoverable and moves councils to the local archive");
});
