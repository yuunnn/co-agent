import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderPromptForSeat,
  cursorRetryDelayMs,
  parseClaudeOutput,
  parseCursorOutput,
  parseOpenCodeDatabase,
  parseOpenCodeExport,
  localProxyEndpoint,
  retryableCursorError,
} from "../src/providers/council.mjs";

test("local proxy diagnostics identify inherited loopback proxy endpoints", () => {
  assert.deepEqual(localProxyEndpoint({ HTTPS_PROXY: "http://127.0.0.1:7890" }), {
    key: "HTTPS_PROXY", value: "http://127.0.0.1:7890", host: "127.0.0.1", port: 7890,
  });
  assert.equal(localProxyEndpoint({ HTTPS_PROXY: "https://remote.example:443" }), null);
});

test("Cursor retries transient transport failures but not hard provider failures", () => {
  assert.equal(retryableCursorError(new Error("read ETIMEDOUT")), true);
  assert.equal(retryableCursorError(new Error("Failed to reach the Cursor API")), true);
  assert.equal(retryableCursorError(new Error("This model provider is not supported in your region")), false);
  assert.equal(retryableCursorError(new Error("Model not available")), false);
  assert.deepEqual([1, 2, 3, 4, 5].map(cursorRetryDelayMs), [1500, 3000, 6000, 8000, 8000]);
});

test("independent prompts are blind while challenge prompts include only eligible prior views", () => {
  const session = {
    title: "Blind review",
    objective: "Review /private/paper.pdf only",
    evidence: {
      mode: "sealed",
      status: "ready",
      packetId: "packet-1",
      sources: [{ name: "paper.pdf", originalPath: "/private/paper.pdf" }],
    },
    events: [
      { actorName: "Claude Code", content: "Eligible independent finding", type: "agent_output", metadata: { roundKind: "independent", eligibleForConsensus: true } },
      { actorName: "OpenCode", content: "Invalid workspace finding", type: "agent_output", metadata: { roundKind: "independent", eligibleForConsensus: false } },
    ],
  };
  const independent = buildProviderPromptForSeat({
    session,
    codexPosition: "Secret Codex anchor",
    focus: "Decide independently",
    roundKind: "independent",
    providerId: "claude-code",
  });
  assert.doesNotMatch(independent, /Secret Codex anchor|Eligible independent finding|Invalid workspace finding/);
  assert.match(independent, /No Codex or peer opinion is included/);
  assert.match(independent, /paper\.pdf only/);
  assert.doesNotMatch(independent, /\/private\/paper\.pdf/);

  const challenge = buildProviderPromptForSeat({
    session,
    codexPosition: "Codex challenge position",
    roundKind: "challenge",
    providerId: "api-provider:test-api",
    inlineEvidence: "sealed manuscript text",
  });
  assert.match(challenge, /Codex challenge position/);
  assert.match(challenge, /Eligible independent finding/);
  assert.doesNotMatch(challenge, /Invalid workspace finding/);
  assert.match(challenge, /sealed manuscript text/);
});

test("provider parsers retain visible output, runtime model, and session identity", () => {
  assert.deepEqual(parseClaudeOutput(JSON.stringify({
    result: "Claude view", session_id: "claude-session", modelUsage: { "claude-default": {} }, usage: { input_tokens: 2 },
  })), {
    content: "Claude view", model: "claude-default", providerSessionId: "claude-session", usage: { input_tokens: 2 },
  });

  const cursor = parseCursorOutput([
    JSON.stringify({ type: "system", subtype: "init", model: "Cursor Default", session_id: "cursor-session" }),
    JSON.stringify({ type: "result", result: "Cursor view", session_id: "cursor-session" }),
  ].join("\n"));
  assert.equal(cursor.content, "Cursor view");
  assert.equal(cursor.model, "Cursor Default");
  assert.equal(cursor.providerSessionId, "cursor-session");

  const openCode = parseOpenCodeExport(JSON.stringify({
    info: { id: "opencode-session" },
    messages: [{
      info: { role: "assistant", providerID: "provider", modelID: "default", tokens: { output: 4 } },
      parts: [{ type: "text", text: "OpenCode view" }],
    }],
  }));
  assert.equal(openCode.content, "OpenCode view");
  assert.equal(openCode.model, "provider/default");
  assert.equal(openCode.providerSessionId, "opencode-session");

  const openCodeDatabase = parseOpenCodeDatabase(JSON.stringify([{
    providerID: "provider", modelID: "default", text: "OpenCode database view",
  }]), "opencode-db-session");
  assert.equal(openCodeDatabase.content, "OpenCode database view");
  assert.equal(openCodeDatabase.model, "provider/default");
  assert.equal(openCodeDatabase.providerSessionId, "opencode-db-session");
});
