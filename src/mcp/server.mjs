import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { prepareEvidencePacket } from "../core/evidence.mjs";
import { apiRequest, ensureDaemon } from "../core/runtime.mjs";
import { COUNCIL_PARTICIPANTS, configuredCouncilParticipants, runExternalCouncil } from "../providers/council.mjs";

const cliPath = fileURLToPath(new URL("../../bin/co-agent.mjs", import.meta.url));
const runningRounds = new Map();

function output(value, message) {
  return {
    content: [{ type: "text", text: message || JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function context() {
  const runtime = await ensureDaemon({ cliPath });
  return { runtime, request: (pathname, options = {}) => apiRequest(runtime, pathname, options) };
}

async function post(request, pathname, body) {
  return request(pathname, { method: "POST", body: JSON.stringify(body) });
}

function councilCounts(session) {
  const totalSeats = Math.max(1, session.participants?.length || 1);
  return {
    totalSeats,
    externalSeats: Math.max(0, totalSeats - 1),
    quorumRequired: Math.floor(totalSeats / 2) + 1,
  };
}

async function executeCouncilRound({ request, session, sessionId, jobId, codexPosition, focus, roundKind, timeoutMs }) {
  const outcomes = [];
  const counts = councilCounts(session);
  try {
    const results = await runExternalCouncil({
      session,
      codexPosition,
      focus,
      roundKind,
      timeoutMs,
      onResult: async (result) => {
        outcomes.push(result);
        const base = session.participants.find((participant) => participant.id === result.id)
          || COUNCIL_PARTICIPANTS.find((participant) => participant.id === result.id);
        await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/participants`, {
          ...base,
          model: result.ok ? result.model : base.model,
          status: result.ok ? "online" : "offline",
          seatState: result.ok ? (result.eligibleForConsensus ? "eligible" : "advisory") : "unavailable",
          stateReason: result.ok
            ? (result.eligibleForConsensus ? `Evidence verified via ${result.evidenceAccess}` : `Not consensus-eligible: ${result.evidenceAccess}`)
            : result.error,
          evidenceCompliant: result.evidenceCompliant,
          latestRoundKind: roundKind,
        });
        await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/events`, {
          type: result.ok ? (roundKind === "challenge" ? "challenge" : "agent_output") : "provider_error",
          actorId: result.id,
          actorName: result.name,
          content: result.ok ? result.content : `Provider unavailable: ${result.error}`,
          provenance: "agent",
          metadata: result.ok ? {
            provider: result.id,
            model: result.model,
            providerSessionId: result.providerSessionId,
            durationMs: result.durationMs,
            attempts: result.attempts || 1,
            roundKind,
            evidenceCompliant: result.evidenceCompliant,
            evidenceAccess: result.evidenceAccess,
            independent: result.independent,
            eligibleForConsensus: result.eligibleForConsensus,
            preflight: result.preflight,
          } : {
            provider: result.id,
            error: result.error,
            roundKind,
            evidenceCompliant: result.evidenceCompliant,
            evidenceAccess: result.evidenceAccess,
            independent: result.independent,
            eligibleForConsensus: false,
            preflight: result.preflight,
          },
        });
        const currentlyEligible = outcomes.filter((outcome) => outcome.ok && outcome.eligibleForConsensus).length + 1;
        await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/state`, {
          roundJob: {
            id: jobId,
            status: "running",
            roundKind,
            completedSeats: outcomes.length,
            totalExternalSeats: counts.externalSeats,
            eligibleSeats: currentlyEligible,
            quorumRequired: counts.quorumRequired,
          },
          actorId: result.id,
          actorName: result.name,
          eventContent: `${result.name} ${result.ok ? (result.eligibleForConsensus ? "completed as eligible" : "completed as advisory") : "failed"}; ${outcomes.length}/${counts.externalSeats} external seats returned.`,
        });
      },
    });
    const current = await request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const succeeded = results.filter((result) => result.ok).length;
    const eligibleExternal = results.filter((result) => result.ok && result.eligibleForConsensus).map((result) => result.id);
    const eligibleSeats = ["codex", ...eligibleExternal];
    const roundSummary = {
      id: jobId,
      roundKind,
      completedAt: new Date().toISOString(),
      succeeded,
      failed: results.length - succeeded,
      eligibleSeats,
      ineligibleSeats: results.filter((result) => !result.ok || !result.eligibleForConsensus).map((result) => ({
        id: result.id,
        reason: result.ok ? `Evidence access ${result.evidenceAccess} is advisory only` : result.error,
      })),
    };
    const priorStatus = current.session.councilStatus || {};
    const quorum = roundKind === "independent" ? {
      required: counts.quorumRequired,
      eligible: eligibleSeats.length,
      eligibleSeats,
      total: counts.totalSeats,
      achieved: eligibleSeats.length >= counts.quorumRequired,
      assessedAt: roundSummary.completedAt,
    } : priorStatus.quorum || {
      required: counts.quorumRequired,
      eligible: 1,
      eligibleSeats: ["codex"],
      total: counts.totalSeats,
      achieved: false,
      assessedAt: roundSummary.completedAt,
    };
    await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/state`, {
      phase: "synthesis",
      round: (current.session.round || 1) + 1,
      roundHistory: [...(current.session.roundHistory || []), roundSummary],
      councilStatus: {
        ...priorStatus,
        quorum,
        evidenceMode: current.session.evidence?.mode || "workspace",
        lastRound: roundSummary,
        scope: quorum.achieved ? "full-council" : "partial-council",
      },
      roundJob: {
        id: jobId,
        status: "completed",
        roundKind,
        completedSeats: results.length,
        totalExternalSeats: counts.externalSeats,
        succeeded,
        failed: results.length - succeeded,
        eligibleSeats: eligibleSeats.length,
        quorumRequired: counts.quorumRequired,
        quorumAchieved: roundKind === "independent" ? quorum.achieved : priorStatus.quorum?.achieved || false,
        completedAt: roundSummary.completedAt,
      },
      actorId: "codex",
      actorName: "Codex",
      eventContent: quorum.achieved
        ? `External seats completed with quorum (${quorum.eligible}/${quorum.required}); Codex is synthesizing.`
        : `External seats completed without quorum (${quorum.eligible}/${quorum.required}); any Co-Result must remain partial.`,
    });
  } catch (error) {
    await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/state`, {
      phase: "synthesis",
      roundJob: {
        id: jobId,
        status: "failed",
        roundKind,
        completedSeats: outcomes.length,
        totalExternalSeats: counts.externalSeats,
        error: String(error?.message || error).slice(0, 1000),
        completedAt: new Date().toISOString(),
      },
      actorId: "system",
      actorName: "Co-Agent",
      eventContent: `Council round stopped after ${outcomes.length}/${counts.externalSeats} external seats returned.`,
    }).catch(() => {});
  } finally {
    runningRounds.delete(sessionId);
  }
}

export async function runMcpServer() {
  const server = new McpServer({ name: "co-agent", version: "0.1.0" });

  server.registerTool("co_agent_open", {
    description: "Open the standalone Co-Agent desktop council, optionally focused on a session.",
    inputSchema: { sessionId: z.string().optional() },
  }, async ({ sessionId }) => {
    const args = [cliPath, "open"];
    if (sessionId) args.push("--session", sessionId);
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
    child.unref();
    return output({ opened: true, sessionId: sessionId || null }, "Opened the Co-Agent desktop app.");
  });

  server.registerTool("co_agent_bind_current", {
    description: "Create or update a Co-Agent council, bind the current Codex task as lead, and select prompt, workspace, or sealed-file evidence.",
    inputSchema: {
      sessionId: z.string().optional(),
      title: z.string().default("Codex council"),
      objective: z.string().default(""),
      cwd: z.string().optional(),
      hostThreadId: z.string().optional(),
      evidencePaths: z.array(z.string()).default([]),
      evidenceMode: z.enum(["auto", "prompt", "workspace", "sealed"]).default("auto"),
      openApp: z.boolean().default(true),
    },
  }, async ({ sessionId, title, objective, cwd, hostThreadId, evidencePaths, evidenceMode, openApp }) => {
    const { request } = await context();
    const threadId = hostThreadId || process.env.CODEX_THREAD_ID || null;
    const boundCwd = cwd || process.cwd();
    let session;
    if (sessionId) {
      ({ session } = await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/state`, {
        controller: { kind: "codex", threadId, boundAt: new Date().toISOString() },
        actorId: "codex",
        actorName: "Codex",
        eventContent: threadId ? "Current Codex task bound as council controller." : "Codex bound as council controller; host task ID was unavailable.",
      }));
    } else {
      const participants = await configuredCouncilParticipants();
      ({ session } = await post(request, "/api/sessions", {
        title,
        objective,
        cwd: boundCwd,
        controller: { kind: "codex", threadId, boundAt: new Date().toISOString() },
        participants,
      }));
      ({ session } = await post(request, `/api/sessions/${encodeURIComponent(session.id)}/events`, {
        type: "binding",
        actorId: "codex",
        actorName: "Codex",
        content: threadId ? "Current Codex task bound as council controller." : "Codex bound as controller. Use hostThreadId for explicit task identity if needed.",
        provenance: "mcp",
      }));
    }
    if (!session.evidence || evidencePaths.length || evidenceMode !== "auto") {
      const evidence = await prepareEvidencePacket({
        sessionId: session.id,
        cwd: session.cwd || boundCwd,
        objective: session.objective || objective,
        evidencePaths,
        mode: evidenceMode,
      });
      ({ session } = await post(request, `/api/sessions/${encodeURIComponent(session.id)}/state`, {
        evidence,
        actorId: "codex",
        actorName: "Codex",
        eventContent: evidence.mode === "sealed"
          ? `Sealed ${evidence.sourceCount}-source evidence packet ${evidence.packetId} prepared.`
          : `Council evidence mode set to ${evidence.mode}.`,
      }));
    }
    if (openApp) {
      const child = spawn(process.execPath, [cliPath, "open", "--session", session.id], { detached: true, stdio: "ignore" });
      child.unref();
    }
    return output({ sessionId: session.id, controller: session.controller, evidence: session.evidence, opened: openApp }, `Bound this Codex task to Co-Agent session ${session.id}.`);
  });

  server.registerTool("co_agent_get_session", {
    description: "Read a bound council including visible deliberation events, agreements, disputes, and its Co-Result.",
    inputSchema: { sessionId: z.string() },
  }, async ({ sessionId }) => {
    const { request } = await context();
    const { session } = await request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return output(session);
  });

  server.registerTool("co_agent_record_output", {
    description: "Record a visible conclusion, challenge, evidence note, or user instruction. Never submit hidden chain-of-thought.",
    inputSchema: {
      sessionId: z.string(), actorId: z.string(), actorName: z.string(), content: z.string(),
      claimIds: z.array(z.string()).default([]),
      kind: z.enum(["agent_output", "challenge", "evidence", "moderation", "user_task"]).default("agent_output"),
      provenance: z.enum(["mcp", "agent", "acp", "user"]).default("agent"),
      sourceUrl: z.string().optional(),
    },
  }, async ({ sessionId, kind, sourceUrl, ...event }) => {
    const { request } = await context();
    const { session } = await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/events`, {
      ...event, type: kind, metadata: sourceUrl ? { sourceUrl } : {},
    });
    return output({ sessionId, eventCount: session.events.length }, `Recorded ${event.actorName}'s visible council output.`);
  });

  server.registerTool("co_agent_publish_result", {
    description: "Publish the council's Co-Result, including dissent and executable next actions.",
    inputSchema: {
      sessionId: z.string(), outcome: z.string(), summary: z.string(),
      actions: z.array(z.string()).default([]), dissent: z.array(z.string()).default([]),
      agreements: z.array(z.string()).default([]), disputes: z.array(z.string()).default([]),
      finalized: z.boolean().default(false),
    },
  }, async ({ sessionId, ...result }) => {
    const { request } = await context();
    const current = await request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const quorum = current.session.councilStatus?.quorum || null;
    result.basis = quorum?.achieved ? "full-council" : "partial-council";
    result.quorum = quorum;
    if (result.agreements.length || result.disputes.length) {
      await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/state`, {
        agreements: result.agreements,
        disputes: result.disputes,
        actorId: "codex",
        actorName: "Codex",
        eventContent: "Council agreement and remaining disputes updated.",
      });
    }
    const { session } = await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/result`, result);
    const scope = result.basis === "full-council" ? "full council" : "partial council without quorum";
    return output({ sessionId, result: session.result }, `Co-Result published from the ${scope}: ${result.outcome}.`);
  });

  server.registerTool("co_agent_start_council_round", {
    description: "Start a non-blocking dynamic council round. Independent rounds blind external seats to Codex and peers; challenge rounds reveal only eligible prior positions. Provider success and consensus eligibility are tracked separately.",
    inputSchema: {
      sessionId: z.string(),
      codexPosition: z.string().min(1),
      focus: z.string().optional(),
      roundKind: z.enum(["independent", "challenge"]).default("independent"),
      evidencePaths: z.array(z.string()).optional(),
      evidenceMode: z.enum(["auto", "prompt", "workspace", "sealed"]).optional(),
      timeoutSeconds: z.number().int().min(30).max(900).default(480),
    },
  }, async ({ sessionId, codexPosition, focus, roundKind, evidencePaths, evidenceMode, timeoutSeconds }) => {
    const active = runningRounds.get(sessionId);
    if (active) return output({ sessionId, started: false, jobId: active.jobId, status: "running" }, `Council session ${sessionId} already has a running round.`);
    const { request } = await context();
    let { session } = await request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const configuredExternalSeats = session.participants.filter((participant) => participant.id !== "codex");
    if (configuredExternalSeats.length === 0) {
      throw new Error("No external providers are enabled. Add and enable at least one terminal Agent or API provider in Co-Agent Settings before starting a council round.");
    }
    if (!session.evidence || evidencePaths?.length || evidenceMode) {
      const evidence = await prepareEvidencePacket({
        sessionId,
        cwd: session.cwd,
        objective: session.objective,
        evidencePaths: evidencePaths || [],
        mode: evidenceMode || "auto",
      });
      ({ session } = await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/state`, {
        evidence,
        actorId: "codex",
        actorName: "Codex",
        eventContent: evidence.mode === "sealed"
          ? `Sealed ${evidence.sourceCount}-source evidence packet ${evidence.packetId} prepared.`
          : `Council evidence mode set to ${evidence.mode}.`,
      }));
    }
    for (const participant of session.participants) {
      const host = participant.id === "codex";
      ({ session } = await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/participants`, {
        ...participant,
        seatState: host ? "eligible" : "checking",
        stateReason: host ? "Current Codex task is the host seat" : "Provider preflight pending",
        evidenceCompliant: host,
      }));
    }
    const counts = councilCounts(session);
    ({ session } = await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/state`, {
      phase: roundKind === "challenge" ? "cross_examination" : "independent",
      actorId: "codex",
      actorName: "Codex",
      eventContent: roundKind === "challenge" ? `The ${counts.totalSeats}-seat council began a challenge round.` : `The ${counts.totalSeats}-seat council began an independent round.`,
    }));
    ({ session } = await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/events`, {
      type: roundKind === "challenge" ? "challenge" : "agent_output",
      actorId: "codex",
      actorName: "Codex",
      content: codexPosition,
      provenance: "mcp",
      metadata: {
        provider: "codex-host",
        model: "current-task",
        roundKind,
        evidenceCompliant: true,
        evidenceAccess: session.evidence?.mode || "workspace",
        independent: roundKind === "independent",
        eligibleForConsensus: true,
      },
    }));
    for (const participant of session.participants.filter((participant) => participant.id !== "codex")) {
      await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/events`, {
        type: "dispatch",
        actorId: participant.id,
        actorName: participant.name,
        content: `${participant.name} started the ${roundKind} round using its configured default model.`,
        provenance: "mcp",
      });
    }
    const jobId = randomUUID();
    ({ session } = await post(request, `/api/sessions/${encodeURIComponent(sessionId)}/state`, {
      roundJob: {
        id: jobId,
        status: "running",
        roundKind,
        completedSeats: 0,
        totalExternalSeats: counts.externalSeats,
        eligibleSeats: 1,
        quorumRequired: counts.quorumRequired,
        startedAt: new Date().toISOString(),
      },
      actorId: "codex",
      actorName: "Codex",
      eventContent: `Council round ${jobId} is running in the background.`,
    }));
    const promise = executeCouncilRound({
      request, session, sessionId, jobId, codexPosition, focus, roundKind, timeoutMs: timeoutSeconds * 1000,
    });
    runningRounds.set(sessionId, { jobId, promise });
    return output({ sessionId, started: true, jobId, status: "running", externalSeats: counts.externalSeats }, `Started ${counts.externalSeats} external seats. Poll co_agent_get_session for roundJob progress while the Co-Agent app updates live.`);
  });

  await server.connect(new StdioServerTransport());
}
