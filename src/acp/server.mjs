import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { apiRequest, ensureDaemon } from "../core/runtime.mjs";

async function createCodexClient() {
  try {
    const { Codex } = await import("@openai/codex-sdk");
    return new Codex();
  } catch {
    throw new Error("ACP host mode requires the optional @openai/codex-sdk package. The standard Codex-first MCP installation does not install this 300 MB dependency.");
  }
}

function promptText(blocks = []) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
}

class CoAgentAcp {
  constructor() {
    this.sessions = new Map();
    this.codex = null;
  }
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }; }
  async authenticate() { return {}; }
  async setSessionMode() { return {}; }

  async newSession(params) {
    const runtime = await ensureDaemon();
    const id = randomUUID();
    const { session } = await apiRequest(runtime, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        id, title: "Experimental ACP bridge", objective: "Expose one read-only Codex-hosted analysis session through Co-Agent's ACP preview.", cwd: params.cwd,
        controller: { kind: "acp", boundAt: new Date().toISOString() },
        participants: [{ id: "codex", name: "Codex", model: "ACP read-only host", role: "lead", color: "#42b8d6", status: "online", seatState: "advisory" }],
      }),
    });
    this.sessions.set(id, { runtime, session, thread: null, abortController: null });
    return { sessionId: id };
  }

  async prompt(params, client) {
    const state = this.sessions.get(params.sessionId);
    if (!state) throw new Error(`Unknown Co-Agent ACP session ${params.sessionId}`);
    const text = promptText(params.prompt);
    state.abortController?.abort();
    state.abortController = new AbortController();
    await apiRequest(state.runtime, `/api/sessions/${params.sessionId}/events`, {
      method: "POST", body: JSON.stringify({ type: "user_task", actorId: "user", actorName: "User", content: text, provenance: "acp" }),
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Co-Agent opened its experimental read-only ACP bridge. This preview uses one Codex host and does not dispatch configured external council seats.\n\n" } },
    });
    if (!state.thread) {
      this.codex ||= await createCodexClient();
      state.thread = this.codex.startThread({ workingDirectory: state.session.cwd || process.cwd(), skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never" });
    }
    try {
      const turn = await state.thread.run(`${text}\n\nThis is the experimental single-host ACP bridge, not a multi-provider council round. Remain read-only. Produce a visible, concise analysis with: outcome, evidence, unresolved questions, and next actions. Do not provide private chain-of-thought.`, { signal: state.abortController.signal });
      await apiRequest(state.runtime, `/api/sessions/${params.sessionId}/events`, {
        method: "POST", body: JSON.stringify({ type: "agent_output", actorId: "codex", actorName: "Codex", content: turn.finalResponse, provenance: "acp", metadata: { codexThreadId: state.thread.id } }),
      });
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: turn.finalResponse } },
      });
      return { stopReason: "end_turn" };
    } catch (error) {
      if (state.abortController.signal.aborted) return { stopReason: "cancelled" };
      throw error;
    }
  }

  async cancel(params) { this.sessions.get(params.sessionId)?.abortController?.abort(); }
}

export async function runAcpServer() {
  const implementation = new CoAgentAcp();
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  acp.agent({ name: "co-agent" })
    .onRequest(acp.methods.agent.initialize, (ctx) => implementation.initialize(ctx.params))
    .onRequest(acp.methods.agent.session.new, (ctx) => implementation.newSession(ctx.params))
    .onRequest(acp.methods.agent.authenticate, (ctx) => implementation.authenticate(ctx.params))
    .onRequest(acp.methods.agent.session.setMode, (ctx) => implementation.setSessionMode(ctx.params))
    .onRequest(acp.methods.agent.session.prompt, (ctx) => implementation.prompt(ctx.params, ctx.client))
    .onNotification(acp.methods.agent.session.cancel, (ctx) => implementation.cancel(ctx.params))
    .connect(stream);
}
