import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dataRoot, packageRoot } from "./paths.mjs";
import { apiRequest, ensureDaemon } from "./runtime.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findAppBinary(override) {
  const candidates = [
    override,
    process.env.CO_AGENT_APP_BIN,
    path.join(packageRoot, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos", "Co-Agent.app", "Contents", "MacOS", "co-agent-app"),
    path.join(packageRoot, "src-tauri", "target", "release", "bundle", "macos", "Co-Agent.app", "Contents", "MacOS", "co-agent-app"),
    path.join(packageRoot, "src-tauri", "target", "release", "co-agent-app"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("Co-Agent Tauri app is not built or executable. Run npm run tauri:build first.");
}

async function logTail(logPath) {
  try {
    const content = await fs.readFile(logPath, "utf8");
    return content.trim().split("\n").slice(-8).join("\n");
  } catch {
    return "";
  }
}

export async function launchDesktopApp({
  sessionId = null,
  cliPath = fileURLToPath(new URL("../../bin/co-agent.mjs", import.meta.url)),
  runtime = null,
  appBinary: appBinaryOverride = null,
  timeoutMs = Number(process.env.CO_AGENT_LAUNCH_TIMEOUT_MS || 15_000),
} = {}) {
  if (!appBinaryOverride && !process.env.CO_AGENT_APP_BIN && process.platform !== "darwin") {
    throw new Error("The prebuilt desktop app currently supports macOS. The daemon and MCP server remain cross-platform; set CO_AGENT_APP_BIN to a locally built desktop binary to override.");
  }
  if (!appBinaryOverride && !process.env.CO_AGENT_APP_BIN && process.platform === "darwin" && process.arch !== "arm64") {
    throw new Error("The npm package currently ships an Apple Silicon desktop app. Set CO_AGENT_APP_BIN to a locally built binary on Intel macOS.");
  }

  const activeRuntime = runtime || await ensureDaemon({ cliPath });
  const appBinary = await findAppBinary(appBinaryOverride);
  const launchId = randomUUID();
  const logsRoot = path.join(dataRoot, "logs");
  const logPath = path.join(logsRoot, "launcher.log");
  await fs.mkdir(logsRoot, { recursive: true });
  await apiRequest(activeRuntime, "/api/desktop/launches", {
    method: "POST",
    body: JSON.stringify({ launchId, sessionId }),
  });

  const args = [];
  if (sessionId) args.push("--session", sessionId);
  args.push("--launch-id", launchId);
  const logHandle = await fs.open(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(appBinary, args, {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: process.env,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    await logHandle.close();
  }
  child.unref();

  const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(500, Math.min(timeoutMs, 60_000)) : 15_000;
  const deadline = Date.now() + boundedTimeout;
  while (Date.now() < deadline) {
    const { launch } = await apiRequest(activeRuntime, `/api/desktop/launches/${encodeURIComponent(launchId)}`);
    if (launch.status === "ready") {
      return {
        opened: true,
        launchId,
        sessionId,
        pid: child.pid,
        readyAt: launch.readyAt,
        url: `http://127.0.0.1:${activeRuntime.port}`,
      };
    }
    if (!processIsAlive(child.pid)) {
      const detail = await logTail(logPath);
      throw new Error(`Co-Agent desktop process exited before its window became ready.${detail ? `\n${detail}` : ""} Launcher log: ${logPath}`);
    }
    await delay(100);
  }

  const detail = await logTail(logPath);
  throw new Error(`Co-Agent desktop window did not become ready within ${boundedTimeout}ms.${detail ? `\n${detail}` : ""} Launcher log: ${logPath}`);
}
