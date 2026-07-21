import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { archivedSessionsRoot, dataRoot, sessionRoot, sessionsRoot } from "./paths.mjs";

const queues = new Map();

function isoNow() {
  return new Date().toISOString();
}

function normalizeSession(raw) {
  const { recommendation: legacyRecommendation, ...session } = raw;
  if (!session.result && legacyRecommendation) {
    const { verdict, ...legacyResult } = legacyRecommendation;
    session.result = { ...legacyResult, outcome: legacyResult.outcome || verdict || "Result" };
    if (session.phase === "recommendation") session.phase = "result";
  }
  return session;
}

async function atomicJsonWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

function enqueue(sessionId, work) {
  const previous = queues.get(sessionId) || Promise.resolve();
  const next = previous.then(work, work);
  queues.set(sessionId, next.finally(() => {
    if (queues.get(sessionId) === next) queues.delete(sessionId);
  }));
  return next;
}

export class FileStore {
  async init() {
    await fs.mkdir(dataRoot, { recursive: true });
    await fs.mkdir(sessionsRoot, { recursive: true });
    await fs.mkdir(archivedSessionsRoot, { recursive: true });
  }

  async archiveSession(id) {
    return enqueue(id, async () => {
      const current = await this.getSession(id, { includeEvents: false });
      const stamp = isoNow().replace(/[:.]/g, "-");
      const destination = path.join(archivedSessionsRoot, `${id}-${stamp}`);
      await fs.rename(sessionRoot(id), destination);
      return { id, title: current.title, archivedAt: isoNow(), destination };
    });
  }

  async listSessions() {
    await this.init();
    const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
    const sessions = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return await this.getSession(entry.name);
        } catch {
          return null;
        }
      }));
    return sessions
      .filter(Boolean)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createSession(input = {}) {
    await this.init();
    const id = input.id || randomUUID();
    const now = isoNow();
    const root = sessionRoot(id);
    await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
    const session = {
      id,
      title: input.title || "Untitled council",
      objective: input.objective || "",
      cwd: input.cwd || process.cwd(),
      status: input.status || "active",
      phase: input.phase || "opening",
      round: input.round || 1,
      totalRounds: input.totalRounds || 4,
      controller: input.controller || null,
      participants: input.participants || [],
      agreements: input.agreements || [],
      disputes: input.disputes || [],
      result: input.result || null,
      createdAt: now,
      updatedAt: now,
    };
    await atomicJsonWrite(path.join(root, "session.json"), session);
    await fs.writeFile(path.join(root, "events.jsonl"), "", { flag: "a" });
    return session;
  }

  async getSession(id, { includeEvents = true } = {}) {
    const root = sessionRoot(id);
    const session = normalizeSession(JSON.parse(await fs.readFile(path.join(root, "session.json"), "utf8")));
    if (!includeEvents) return session;
    let events = [];
    try {
      const raw = await fs.readFile(path.join(root, "events.jsonl"), "utf8");
      events = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { ...session, events };
  }

  async updateSession(id, patch, event = null) {
    return enqueue(id, async () => {
      const root = sessionRoot(id);
      const current = await this.getSession(id, { includeEvents: false });
      const resolvedPatch = typeof patch === "function" ? await patch(current) : patch;
      const updated = { ...current, ...resolvedPatch, id, updatedAt: isoNow() };
      await atomicJsonWrite(path.join(root, "session.json"), updated);
      if (event) await this.appendEventUnlocked(id, event);
      return this.getSession(id);
    });
  }

  async appendEvent(id, event) {
    return enqueue(id, async () => {
      await this.appendEventUnlocked(id, event);
      const current = await this.getSession(id, { includeEvents: false });
      current.updatedAt = isoNow();
      await atomicJsonWrite(path.join(sessionRoot(id), "session.json"), current);
      return this.getSession(id);
    });
  }

  async appendEventUnlocked(id, event) {
    const normalized = {
      id: event.id || randomUUID(),
      type: event.type || "agent_output",
      actorId: event.actorId || "system",
      actorName: event.actorName || event.actorId || "System",
      content: event.content || "",
      claimIds: event.claimIds || [],
      provenance: event.provenance || "co-agent",
      createdAt: event.createdAt || isoNow(),
      metadata: event.metadata || {},
    };
    await fs.appendFile(
      path.join(sessionRoot(id), "events.jsonl"),
      `${JSON.stringify(normalized)}\n`,
      "utf8",
    );
    return normalized;
  }
}
