import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { ConfigStore, testOpenAiCompatibleProvider } from "../core/config.mjs";
import { FileStore } from "../core/store.mjs";
import { dataRoot, runtimePath, webRoot } from "../core/paths.mjs";
import { inspectTerminalAgents, testTerminalAgent } from "../providers/council.mjs";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 5 * 1024 * 1024) throw new Error("Request body exceeds 5 MB");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(request, token, url) {
  return request.headers.authorization === `Bearer ${token}` || url.searchParams.get("token") === token;
}

async function staticFile(response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(webRoot, normalized);
  if (!filePath.startsWith(webRoot)) return false;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "cache-control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    });
    response.end(content);
    return true;
  } catch {
    if (!path.extname(pathname)) {
      try {
        const content = await fs.readFile(path.join(webRoot, "index.html"));
        response.writeHead(200, { "content-type": MIME_TYPES[".html"], "cache-control": "no-store" });
        response.end(content);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export async function startDaemon({ port = 0 } = {}) {
  await fs.mkdir(dataRoot, { recursive: true });
  const token = randomBytes(24).toString("hex");
  const store = new FileStore();
  const configStore = new ConfigStore();
  await store.init();
  await configStore.init();

  const sockets = new Set();
  const broadcast = (payload) => {
    const message = JSON.stringify(payload);
    for (const socket of sockets) {
      if (socket.readyState === 1) socket.send(message);
    }
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    try {
      if (url.pathname === "/api/health") {
        return sendJson(response, 200, { ok: true, pid: process.pid });
      }
      if (url.pathname.startsWith("/api/") && !authorized(request, token, url)) {
        return sendJson(response, 401, { error: "Unauthorized" });
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        return sendJson(response, 200, { sessions: await store.listSessions() });
      }
      if (request.method === "GET" && url.pathname === "/api/sessions") {
        return sendJson(response, 200, { sessions: await store.listSessions() });
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        return sendJson(response, 200, { config: await configStore.read() });
      }
      if (request.method === "POST" && url.pathname === "/api/config/theme") {
        const body = await readJson(request);
        const config = await configStore.setTheme(body.theme);
        broadcast({ type: "config.updated", config });
        return sendJson(response, 200, { config });
      }
      if (request.method === "GET" && url.pathname === "/api/providers/agents") {
        const latestSession = (await store.listSessions())[0];
        return sendJson(response, 200, { providers: await inspectTerminalAgents({ cwd: latestSession?.cwd || dataRoot }) });
      }
      if (request.method === "POST" && url.pathname === "/api/providers/agents") {
        const body = await readJson(request);
        const candidate = await configStore.previewAgentProvider({ ...body, enabled: body.enabled ?? true });
        const latestSession = (await store.listSessions())[0];
        const result = await testTerminalAgent(candidate, { cwd: latestSession?.cwd || dataRoot });
        const config = await configStore.upsertAgentProvider({ ...body, enabled: body.enabled ?? true });
        const provider = body.id
          ? config.agentProviders.find((item) => item.id === body.id)
          : config.agentProviders.find((item) => item.name === candidate.name && item.command === candidate.command);
        broadcast({ type: "config.updated", config });
        return sendJson(response, 200, { config, provider, result });
      }
      if (request.method === "POST" && url.pathname === "/api/providers/api") {
        const body = await readJson(request);
        const candidate = await configStore.previewApiProvider(body);
        const result = await testOpenAiCompatibleProvider(candidate);
        const config = await configStore.upsertApiProvider(body);
        const provider = body.id
          ? config.apiProviders.find((item) => item.id === body.id)
          : config.apiProviders.find((item) => item.name === candidate.name && item.baseUrl === candidate.baseUrl && item.model === candidate.model);
        broadcast({ type: "config.updated", config });
        return sendJson(response, 200, { config, provider, result });
      }
      const apiProviderMatch = url.pathname.match(/^\/api\/providers\/api\/([^/]+)(?:\/(test|enabled))?$/);
      if (apiProviderMatch) {
        const [, providerId, action] = apiProviderMatch;
        if (request.method === "DELETE" && !action) {
          const config = await configStore.removeApiProvider(providerId);
          broadcast({ type: "config.updated", config });
          return sendJson(response, 200, { config });
        }
        if (request.method === "POST" && action === "test") {
          const result = await testOpenAiCompatibleProvider(await configStore.getApiProvider(providerId));
          return sendJson(response, 200, { result });
        }
        if (request.method === "POST" && action === "enabled") {
          const body = await readJson(request);
          const provider = await configStore.getApiProvider(providerId);
          let result = null;
          if (body.enabled) result = await testOpenAiCompatibleProvider(provider);
          const config = await configStore.upsertApiProvider({ ...provider, token: "", enabled: Boolean(body.enabled) });
          broadcast({ type: "config.updated", config });
          return sendJson(response, 200, { config, result });
        }
      }
      const agentProviderMatch = url.pathname.match(/^\/api\/providers\/agents\/([^/]+)(?:\/(test|enabled))?$/);
      if (agentProviderMatch) {
        const [, providerId, action] = agentProviderMatch;
        if (request.method === "DELETE" && !action) {
          const config = await configStore.removeAgentProvider(providerId);
          broadcast({ type: "config.updated", config });
          return sendJson(response, 200, { config });
        }
        const latestSession = (await store.listSessions())[0];
        const provider = await configStore.getAgentProvider(providerId);
        if (request.method === "POST" && action === "test") {
          const result = await testTerminalAgent(provider, { cwd: latestSession?.cwd || dataRoot });
          return sendJson(response, 200, { result });
        }
        if (request.method === "POST" && action === "enabled") {
          const body = await readJson(request);
          let result = null;
          if (body.enabled) result = await testTerminalAgent(provider, { cwd: latestSession?.cwd || dataRoot });
          const config = await configStore.upsertAgentProvider({ ...provider, enabled: Boolean(body.enabled) });
          broadcast({ type: "config.updated", config });
          return sendJson(response, 200, { config, result });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/sessions") {
        const session = await store.createSession(await readJson(request));
        broadcast({ type: "session.created", session });
        return sendJson(response, 201, { session });
      }

      const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/);
      if (match) {
        const [, sessionId, action] = match;
        if (request.method === "GET" && !action) {
          return sendJson(response, 200, { session: await store.getSession(sessionId) });
        }
        if (request.method === "DELETE" && !action) {
          const archived = await store.archiveSession(sessionId);
          broadcast({ type: "session.deleted", sessionId });
          return sendJson(response, 200, { archived: { id: archived.id, title: archived.title, archivedAt: archived.archivedAt } });
        }
        const body = await readJson(request);
        let session;
        if (request.method === "POST" && action === "events") {
          session = await store.appendEvent(sessionId, body);
        } else if (request.method === "POST" && action === "participants") {
          session = await store.updateSession(sessionId, (current) => {
            const participant = body.id ? body : { ...body, id: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") };
            const others = current.participants.filter((item) => item.id !== participant.id);
            return { participants: [...others, participant] };
          }, { type: "participant_updated", actorId: "system", content: `${body.name} joined the council.` });
        } else if (request.method === "POST" && (action === "result" || action === "recommendation")) {
          const result = body.outcome ? body : { ...body, outcome: body.verdict };
          delete result.verdict;
          session = await store.updateSession(sessionId, { result, phase: result.finalized ? "result" : "synthesis" }, {
            type: "result_published",
            actorId: body.actorId || "codex",
            actorName: body.actorName || "Codex",
            content: `${result.outcome}: ${result.summary}`,
          });
        } else if (request.method === "POST" && action === "state") {
          const { actorId, actorName, eventContent, ...state } = body;
          session = await store.updateSession(sessionId, state, {
            type: "state_updated",
            actorId: actorId || "system",
            actorName: actorName || actorId || "System",
            content: eventContent || "Council state updated.",
          });
        } else {
          return sendJson(response, 404, { error: "Unknown Co-Agent route" });
        }
        broadcast({ type: "session.updated", session });
        return sendJson(response, 200, { session });
      }

      if (url.pathname.startsWith("/api/")) return sendJson(response, 404, { error: "Not found" });
      if (await staticFile(response, url.pathname)) return;
      return sendJson(response, 503, { error: "Co-Agent frontend has not been built. Run npm run build." });
    } catch (error) {
      console.error("[co-agent]", error);
      return sendJson(response, 500, { error: error.message || "Internal error" });
    }
  });

  const websocket = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/ws" || !authorized(request, token, url)) {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client));
  });
  websocket.on("connection", (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: "connected" }));
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const runtime = {
    pid: process.pid,
    port: address.port,
    token,
    startedAt: new Date().toISOString(),
  };
  await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(runtimePath, 0o600);

  const cleanup = async () => {
    try {
      const current = JSON.parse(await fs.readFile(runtimePath, "utf8"));
      if (current.pid === process.pid) await fs.unlink(runtimePath);
    } catch {}
  };
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => websocket.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  server.once("close", cleanup);
  return { server, runtime, store };
}
