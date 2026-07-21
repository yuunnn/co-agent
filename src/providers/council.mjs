import { spawn } from "node:child_process";
import net from "node:net";
import { ConfigStore, openAiCompatibleChat } from "../core/config.mjs";
import { readSealedEvidence, sanitizeEvidenceReferences } from "../core/evidence.mjs";

const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function executable(name, environmentName) {
  return process.env[environmentName] || name;
}

function conciseError(value) {
  return String(value || "Unknown provider failure")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim()
    .slice(0, 2000);
}

export function runCommand(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)} seconds`));
      settled = true;
    }, timeoutMs);
    timer.unref();

    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        if (!settled) reject(new Error(`${command} produced more than 16 MB of output`));
        settled = true;
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) reject(error);
      settled = true;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(conciseError(errorOutput || output || `${command} exited with ${code ?? signal}`)));
        return;
      }
      resolve({ stdout: output, stderr: errorOutput, code: code ?? 0 });
    });
  });
}

function jsonLines(raw) {
  return raw.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function parseClaudeOutput(raw) {
  const payload = JSON.parse(raw);
  if (payload.is_error || !payload.result) throw new Error(payload.result || "Claude Code returned no visible result");
  return {
    content: payload.result.trim(),
    model: Object.keys(payload.modelUsage || {})[0] || "CLI default",
    providerSessionId: payload.session_id || null,
    usage: payload.usage || null,
  };
}

export function parseCursorOutput(raw) {
  const events = jsonLines(raw);
  const initialized = events.find((event) => event.type === "system" && event.subtype === "init");
  const result = [...events].reverse().find((event) => event.type === "result");
  if (!result || result.is_error || !result.result) throw new Error(result?.result || "Cursor Agent returned no visible result");
  return {
    content: result.result.trim(),
    model: initialized?.model || "CLI default",
    providerSessionId: result.session_id || initialized?.session_id || null,
    usage: result.usage || null,
  };
}

export function parseOpenCodeExport(raw) {
  const payloadStart = raw.indexOf("{");
  const payload = JSON.parse(payloadStart >= 0 ? raw.slice(payloadStart) : raw);
  const assistant = [...(payload.messages || [])].reverse().find((message) => message.info?.role === "assistant");
  const content = (assistant?.parts || [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!assistant || !content) throw new Error("OpenCode returned no visible result");
  const provider = assistant.info.providerID;
  const model = assistant.info.modelID;
  return {
    content,
    model: provider && model ? `${provider}/${model}` : model || "CLI default",
    providerSessionId: payload.info?.id || assistant.info.sessionID || null,
    usage: assistant.info.tokens || null,
  };
}

export function parseOpenCodeDatabase(raw, sessionId) {
  const rows = JSON.parse(raw);
  const row = rows[0];
  if (!row?.text) throw new Error("OpenCode returned no visible result");
  return {
    content: row.text.trim(),
    model: row.providerID && row.modelID ? `${row.providerID}/${row.modelID}` : row.modelID || "CLI default",
    providerSessionId: sessionId,
    usage: null,
  };
}

export function buildProviderPrompt({ session, codexPosition, focus, roundKind = "independent" }) {
  return buildProviderPromptForSeat({ session, codexPosition, focus, roundKind });
}

export function buildProviderPromptForSeat({
  session,
  codexPosition,
  focus,
  roundKind = "independent",
  providerId = "external-seat",
  inlineEvidence = "",
}) {
  const evidence = session.evidence || { mode: "workspace", status: "workspace", sources: [] };
  const sanitize = (value) => sanitizeEvidenceReferences(value, evidence);
  const task = sanitize(session.objective || session.title);
  const independent = roundKind === "independent";
  const eligiblePrior = independent ? [] : (session.events || [])
    .filter((event) => ["agent_output", "evidence", "position_change"].includes(event.type))
    .filter((event) => event.metadata?.roundKind === "independent")
    .filter((event) => event.metadata?.eligibleForConsensus !== false)
    .slice(-10)
    .map((event) => `${event.actorName}: ${sanitize(event.content)}`);
  const apiOnlySeat = providerId === "api-provider" || providerId.startsWith("api-provider:");
  const evidenceInstruction = evidence.mode === "sealed"
    ? apiOnlySeat
      ? "The complete sealed evidence packet is embedded below. Use no facts from outside that packet."
      : "Your current working directory is a sealed, read-only evidence workspace. Read task.txt, manifest.json, and council-evidence.txt. Do not access any path outside this workspace."
    : evidence.mode === "prompt"
      ? "This is a prompt-only council task; no workspace evidence is required."
      : apiOnlySeat
        ? "You cannot inspect the bound local workspace. Clearly label any conclusion that depends only on the task statement."
        : "Inspect the bound workspace only when needed and remain strictly read-only.";
  const material = [
    `You are one seat in a ${session.participants?.length || "multi"}-member software and research council.`,
    `Council task: ${task}`,
    focus ? `Focus for this round: ${sanitize(focus)}` : null,
    `Round type: ${roundKind}`,
    independent
      ? "INDEPENDENCE RULE: Reach your own view before seeing any host or peer position. No Codex or peer opinion is included in this prompt."
      : "CHALLENGE RULE: Test the strongest competing claims below against the evidence; do not merely echo them.",
    evidenceInstruction,
    !independent ? "The Codex host's current visible position:" : null,
    !independent ? sanitize(codexPosition) : null,
    !independent ? "Eligible independent-round positions:" : null,
    !independent ? (eligiblePrior.join("\n\n") || "No eligible external position was available.") : null,
    "Return a concise visible answer with exactly these headings: Position; Evidence basis; Strongest evidence; Challenge; Agreement; Remaining dispute; Next action.",
    "Under Evidence basis, name the packet files or workspace files actually used. Do not reveal private chain-of-thought. Give conclusions and verifiable evidence only.",
    inlineEvidence ? `<sealed_evidence packet="${evidence.packetId}">\n${inlineEvidence}\n</sealed_evidence>` : null,
  ];
  return material.filter(Boolean).join("\n\n");
}

export async function runClaudeCode({ prompt, cwd, timeoutMs, command = executable("claude", "CLAUDE_CODE_BIN") }) {
  const startedAt = Date.now();
  const result = await runCommand(command, [
    "-p", prompt,
    "--output-format", "json",
    "--permission-mode", "plan",
    "--max-turns", "12",
    "--tools", "Read,Glob,Grep",
    "--no-session-persistence",
  ], { cwd, timeoutMs });
  return { ...parseClaudeOutput(result.stdout), durationMs: Date.now() - startedAt };
}

export async function runCursorAgent({ prompt, cwd, timeoutMs, command = executable("cursor-agent", "CURSOR_AGENT_BIN") }) {
  const startedAt = Date.now();
  const result = await runCommand(command, [
    "-p", prompt,
    "--output-format", "stream-json",
    "--mode", "ask",
    "--sandbox", "enabled",
    "--trust",
    "--workspace", cwd,
  ], { cwd, timeoutMs });
  return { ...parseCursorOutput(result.stdout), durationMs: Date.now() - startedAt };
}

export function retryableCursorError(error) {
  const message = String(error?.message || error);
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|Failed to reach the Cursor API|network/i.test(message)
    && !/not supported in your region|model not available|invalid.*api.?key|unauthenticated|unauthorized/i.test(message);
}

export function cursorRetryDelayMs(attempt) {
  return Math.min(8_000, 1_500 * (2 ** Math.max(0, attempt - 1)));
}

export async function runCursorAgentWithRetry({ prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, command = executable("cursor-agent", "CURSOR_AGENT_BIN") }) {
  const deadline = Date.now() + timeoutMs;
  let firstError;
  let attempt = 0;
  while (true) {
    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining < 15_000) break;
    try {
      return { ...await runCursorAgent({ prompt, cwd, timeoutMs: remaining, command }), attempts: attempt };
    } catch (error) {
      if (attempt === 1) firstError = error;
      if (!retryableCursorError(error)) throw error;
      const delayMs = cursorRetryDelayMs(attempt);
      if (deadline - Date.now() < delayMs + 15_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw firstError || new Error("Cursor Agent exhausted its council deadline before a request could complete");
}

export async function runOpenCode({ prompt, cwd, timeoutMs, command = executable("opencode", "OPENCODE_BIN") }) {
  const startedAt = Date.now();
  const binary = command;
  const restrictiveConfig = JSON.stringify({
    permission: {
      edit: "deny",
      bash: "deny",
      task: "deny",
      skill: "deny",
      webfetch: "deny",
      websearch: "deny",
      external_directory: "deny",
    },
  });
  const invocation = await runCommand(binary, [
    "run", "--pure", "--format", "json",
    "--agent", "plan",
    "--dir", cwd,
    prompt,
  ], { cwd, timeoutMs, env: { OPENCODE_CONFIG_CONTENT: restrictiveConfig } });
  const sessionId = jsonLines(invocation.stdout).find((event) => event.sessionID)?.sessionID;
  if (!sessionId) throw new Error("OpenCode did not report a session ID");
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("OpenCode returned an invalid session ID");
  const query = `SELECT json_extract(m.data, '$.providerID') AS providerID, json_extract(m.data, '$.modelID') AS modelID, json_extract(p.data, '$.text') AS text FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = '${sessionId}' AND json_extract(m.data, '$.role') = 'assistant' AND json_extract(p.data, '$.type') = 'text' ORDER BY p.time_created DESC LIMIT 1`;
  const queried = await runCommand(binary, ["db", "--format", "json", query], { cwd, timeoutMs: Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, 60_000) });
  return { ...parseOpenCodeDatabase(queried.stdout, sessionId), durationMs: Date.now() - startedAt };
}

export const COUNCIL_PARTICIPANTS = [
  { id: "codex", name: "Codex", model: "Current task", role: "lead", color: "#42b8d6", status: "online", seatState: "eligible" },
  { id: "claude-code", name: "Claude Code", model: "CLI default", role: "member", color: "#d88964", status: "waiting", seatState: "checking" },
  { id: "cursor-agent", name: "Cursor Agent", model: "CLI default", role: "member", color: "#9c8ce8", status: "waiting", seatState: "checking" },
  { id: "opencode", name: "OpenCode", model: "CLI default", role: "member", color: "#67b887", status: "waiting", seatState: "checking" },
];

const API_SEAT_COLORS = ["#e2b45f", "#d88964", "#9c8ce8", "#67b887", "#42b8d6", "#d96c9d"];
const AGENT_SEAT_COLORS = ["#d88964", "#9c8ce8", "#67b887", "#42b8d6", "#d96c9d", "#e2b45f"];

function isApiProviderSeat(participant) {
  return participant?.providerKind === "openai-compatible"
    || participant?.id === "api-provider"
    || participant?.id?.startsWith("api-provider:");
}

function isTerminalAgentSeat(participant) {
  return participant?.providerKind === "terminal-agent"
    || ["claude-code", "cursor-agent", "opencode"].includes(participant?.id);
}

function terminalAgentSpec(participant) {
  if (participant.providerKind === "terminal-agent") return participant;
  const adapter = participant.adapter || participant.id;
  const defaults = {
    "claude-code": "claude",
    "cursor-agent": "cursor-agent",
    opencode: "opencode",
  };
  return { ...participant, adapter, command: participant.command || defaults[adapter] };
}

export async function configuredCouncilParticipants() {
  const store = new ConfigStore();
  const [configuredAgents, configuredApis] = await Promise.all([
    store.getEnabledAgentProviders(),
    store.getEnabledApiProviders(),
  ]);
  return [
    COUNCIL_PARTICIPANTS[0],
    ...configuredAgents.map((provider, index) => ({
      id: `terminal-agent:${provider.id}`,
      name: provider.name,
      model: "CLI default",
      role: "member",
      color: AGENT_SEAT_COLORS[index % AGENT_SEAT_COLORS.length],
      status: "waiting",
      seatState: "checking",
      providerConfigId: provider.id,
      providerKind: "terminal-agent",
      adapter: provider.adapter,
      command: provider.command,
    })),
    ...configuredApis.map((provider, index) => ({
      id: `api-provider:${provider.id}`,
      name: provider.name,
      model: provider.model,
      role: "member",
      color: API_SEAT_COLORS[index % API_SEAT_COLORS.length],
      status: "waiting",
      seatState: "checking",
      providerConfigId: provider.id,
      providerKind: "openai-compatible",
    })),
  ];
}

export async function inspectTerminalAgents({ cwd = process.cwd(), timeoutMs = 10_000, providers } = {}) {
  const agents = providers || (await new ConfigStore().read()).agentProviders;
  return Promise.all(agents.map(async (agent) => {
    try {
      const result = await runCommand(agent.command, ["--version"], { cwd, timeoutMs });
      return { ...agent, status: "available", version: (result.stdout || result.stderr).split("\n")[0].trim(), credentialSource: "Terminal session" };
    } catch (error) {
      return { ...agent, status: "unavailable", version: "Not detected", credentialSource: "Terminal session", error: conciseError(error.message || error) };
    }
  }));
}

export async function testTerminalAgent(providerOrAdapter, { cwd = process.cwd(), timeoutMs = 120_000 } = {}) {
  const prompt = "Do not inspect files or call tools. Reply with exactly: CO_AGENT_AGENT_OK";
  const startedAt = Date.now();
  const defaults = {
    "claude-code": { adapter: "claude-code", command: executable("claude", "CLAUDE_CODE_BIN") },
    "cursor-agent": { adapter: "cursor-agent", command: executable("cursor-agent", "CURSOR_AGENT_BIN") },
    opencode: { adapter: "opencode", command: executable("opencode", "OPENCODE_BIN") },
  };
  const provider = typeof providerOrAdapter === "string" ? defaults[providerOrAdapter] : providerOrAdapter;
  if (!provider) throw new Error("Unknown terminal agent");
  let result;
  if (provider.adapter === "claude-code") result = await runClaudeCode({ prompt, cwd, timeoutMs, command: provider.command });
  else if (provider.adapter === "cursor-agent") result = await runCursorAgentWithRetry({ prompt, cwd, timeoutMs, command: provider.command });
  else if (provider.adapter === "opencode") result = await runOpenCode({ prompt, cwd, timeoutMs, command: provider.command });
  else throw new Error("Unknown terminal agent");
  return { ok: true, model: result.model, response: result.content.slice(0, 160), durationMs: Date.now() - startedAt };
}

async function probe(name, run) {
  try {
    await run();
    return { id: name, ok: true };
  } catch (error) {
    return { id: name, ok: false, error: conciseError(error?.message || error) };
  }
}

export function localProxyEndpoint(environment = process.env) {
  for (const key of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]) {
    const value = environment[key];
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) continue;
      const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
      if (Number.isInteger(port) && port > 0) return { key, value, host: parsed.hostname, port };
    } catch {}
  }
  return null;
}

function tcpReachable({ host, port }, timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function preflightCursor(session, workspace, timeoutMs, participant = { id: "cursor-agent", command: executable("cursor-agent", "CURSOR_AGENT_BIN") }) {
  try {
    const proxy = localProxyEndpoint();
    if (proxy && !await tcpReachable(proxy)) {
      return {
        id: participant.id,
        ok: false,
        error: `Configured ${proxy.key} points to ${proxy.host}:${proxy.port}, but no proxy listener is reachable. Start the local proxy or correct the proxy environment before running Cursor Agent.`,
      };
    }
    try {
      await runCommand(participant.command, ["--list-models"], {
        cwd: workspace,
        timeoutMs,
      });
      return { id: participant.id, ok: true };
    } catch (error) {
      const message = conciseError(error?.message || error);
      const hardFailure = /not supported in your region|model not available|invalid.*api.?key|unauthenticated|unauthorized/i.test(message);
      if (hardFailure) return { id: participant.id, ok: false, error: message };
      return { id: participant.id, ok: true, warning: `Remote preflight was inconclusive; formal call will decide availability: ${message}` };
    }
  } catch (error) {
    return { id: participant.id, ok: false, error: conciseError(error?.message || error) };
  }
}

async function preflightTerminalAgent(session, workspace, timeoutMs, participant) {
  const agent = terminalAgentSpec(participant);
  if (agent.adapter === "cursor-agent") return preflightCursor(session, workspace, timeoutMs, agent);
  return probe(agent.id, () => runCommand(agent.command, ["--version"], { cwd: workspace, timeoutMs }));
}

async function runTerminalAgentSeat({ participant, prompt, cwd, timeoutMs }) {
  const agent = terminalAgentSpec(participant);
  if (agent.adapter === "claude-code") return runClaudeCode({ prompt, cwd, timeoutMs, command: agent.command });
  if (agent.adapter === "cursor-agent") return runCursorAgentWithRetry({ prompt, cwd, timeoutMs, command: agent.command });
  if (agent.adapter === "opencode") return runOpenCode({ prompt, cwd, timeoutMs, command: agent.command });
  throw new Error(`Unsupported terminal agent adapter: ${agent.adapter}`);
}

async function runConfiguredApiProvider({ prompt, providerConfigId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const provider = await new ConfigStore().getApiProvider(providerConfigId);
  const result = await openAiCompatibleChat(provider, {
    messages: [
      { role: "system", content: "You are an API model seat in a multi-model council. Return visible conclusions and evidence, never private chain-of-thought." },
      { role: "user", content: prompt },
    ],
    maxTokens: 4096,
    timeoutMs,
  });
  return { content: result.content, model: result.payload.model || provider.model, providerSessionId: result.payload.id || null, usage: result.payload.usage || null, durationMs: result.durationMs };
}

export async function preflightCouncilProviders({ session, timeoutMs = 20_000 }) {
  const workspace = session.evidence?.mode === "sealed" ? session.evidence.packetPath : session.cwd;
  const evidenceFailure = session.evidence?.mode === "sealed" && session.evidence?.status !== "ready"
    ? "Sealed evidence packet is not ready"
    : null;
  if (evidenceFailure) {
    return (session.participants || COUNCIL_PARTICIPANTS).filter((participant) => participant.id !== "codex").map((participant) => ({ id: participant.id, ok: false, error: evidenceFailure }));
  }
  const terminalSeats = (session.participants || []).filter(isTerminalAgentSeat);
  const apiSeats = (session.participants || []).filter(isApiProviderSeat);
  const apiProbes = apiSeats.map((apiSeat) => probe(apiSeat.id, async () => {
    await new ConfigStore().getApiProvider(apiSeat.providerConfigId);
    if (session.evidence?.mode === "sealed") await readSealedEvidence(session.evidence);
  }));
  return Promise.all([
    ...terminalSeats.map((participant) => preflightTerminalAgent(session, workspace, timeoutMs, participant)),
    ...apiProbes,
  ]);
}

function evidenceEligibility(session, providerId) {
  const mode = session.evidence?.mode || "workspace";
  if (mode === "sealed") return { evidenceCompliant: session.evidence?.status === "ready", evidenceAccess: "sealed-packet" };
  if (mode === "prompt") return { evidenceCompliant: true, evidenceAccess: "prompt" };
  if (providerId === "api-provider" || providerId.startsWith("api-provider:")) return { evidenceCompliant: false, evidenceAccess: "prompt-only" };
  return { evidenceCompliant: true, evidenceAccess: "read-only-workspace" };
}

export async function runExternalCouncil({ session, codexPosition, focus, roundKind, timeoutMs, onResult }) {
  const workspace = session.evidence?.mode === "sealed" ? session.evidence.packetPath : session.cwd;
  const preflight = await preflightCouncilProviders({ session, timeoutMs: Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, 20_000) });
  const preflightById = new Map(preflight.map((result) => [result.id, result]));
  const inlineEvidence = session.evidence?.mode === "sealed" ? await readSealedEvidence(session.evidence).catch(() => "") : "";
  const promptFor = (providerId) => buildProviderPromptForSeat({
    session,
    codexPosition,
    focus,
    roundKind,
    providerId,
    inlineEvidence: providerId === "api-provider" || providerId.startsWith("api-provider:") ? inlineEvidence : "",
  });
  const terminalSeats = (session.participants || []).filter(isTerminalAgentSeat);
  const apiSeats = (session.participants || []).filter(isApiProviderSeat);
  const providers = [
    ...terminalSeats.map((participant) => [participant.id, participant.name, () => runTerminalAgentSeat({ participant, prompt: promptFor(participant.id), cwd: workspace, timeoutMs })]),
    ...apiSeats.map((apiSeat) => [apiSeat.id, apiSeat.name, () => runConfiguredApiProvider({ prompt: promptFor(apiSeat.id), providerConfigId: apiSeat.providerConfigId, timeoutMs })]),
  ];
  return Promise.all(providers.map(async ([id, name, run]) => {
    let normalized;
    const capability = evidenceEligibility(session, id);
    const ready = preflightById.get(id);
    try {
      if (!ready?.ok) throw new Error(`Preflight failed: ${ready?.error || "provider is unavailable"}`);
      const result = await run();
      normalized = {
        id,
        name,
        ok: true,
        ...result,
        ...capability,
        independent: roundKind === "independent",
        eligibleForConsensus: capability.evidenceCompliant,
        preflight: ready,
      };
    } catch (error) {
      normalized = {
        id,
        name,
        ok: false,
        error: conciseError(error?.message || error),
        ...capability,
        independent: roundKind === "independent",
        eligibleForConsensus: false,
        preflight: ready,
      };
    }
    if (onResult) await onResult(normalized);
    return normalized;
  }));
}
