#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../src/server/daemon.mjs";
import { ensureDaemon, readRuntime, runtimeIsHealthy } from "../src/core/runtime.mjs";
import { bundledSkillRoot, packageRoot } from "../src/core/paths.mjs";

const command = process.argv[2] || "open";
const argumentsAfterCommand = process.argv.slice(3);

async function openApp() {
  if (process.platform !== "darwin" && !process.env.CO_AGENT_APP_BIN) {
    throw new Error("The prebuilt desktop app currently supports macOS. The daemon and MCP server remain cross-platform; set CO_AGENT_APP_BIN to a locally built desktop binary to override.");
  }
  if (process.platform === "darwin" && process.arch !== "arm64" && !process.env.CO_AGENT_APP_BIN) {
    throw new Error("The npm package currently ships an Apple Silicon desktop app. Set CO_AGENT_APP_BIN to a locally built binary on Intel macOS.");
  }
  const runtime = await ensureDaemon({ cliPath: fileURLToPath(import.meta.url) });
  const sessionIndex = argumentsAfterCommand.indexOf("--session");
  const sessionId = sessionIndex >= 0 ? argumentsAfterCommand[sessionIndex + 1] : null;
  const candidates = [
    process.env.CO_AGENT_APP_BIN,
    path.join(packageRoot, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos", "Co-Agent.app", "Contents", "MacOS", "co-agent-app"),
    path.join(packageRoot, "src-tauri", "target", "release", "bundle", "macos", "Co-Agent.app", "Contents", "MacOS", "co-agent-app"),
    path.join(packageRoot, "src-tauri", "target", "release", "co-agent-app"),
  ].filter(Boolean);
  let appBinary = null;
  for (const candidate of candidates) {
    try { await fs.access(candidate); appBinary = candidate; break; } catch {}
  }
  if (!appBinary) throw new Error("Co-Agent Tauri app is not built. Run npm run tauri:build first.");
  const appArgs = sessionId ? ["--session", sessionId] : [];
  const child = spawn(appBinary, appArgs, { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  console.log(`Co-Agent Tauri app opened at http://127.0.0.1:${runtime.port}`);
}

async function setupCodex() {
  const skillDestination = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "skills", "co-agent");
  await fs.mkdir(path.dirname(skillDestination), { recursive: true });
  await fs.rm(skillDestination, { recursive: true, force: true });
  await fs.cp(bundledSkillRoot, skillDestination, { recursive: true });

  const existing = spawnSync("codex", ["mcp", "get", "co-agent", "--json"], { encoding: "utf8" });
  if (existing.status === 0) {
    const removal = spawnSync("codex", ["mcp", "remove", "co-agent"], { stdio: "inherit" });
    if (removal.status !== 0) throw new Error("Could not replace the existing Co-Agent MCP entry");
  }
  const executable = process.argv[1];
  const added = spawnSync("codex", ["mcp", "add", "co-agent", "--", process.execPath, executable, "mcp"], { stdio: "inherit" });
  if (added.status !== 0) throw new Error("Could not register Co-Agent MCP with Codex");
  console.log(`Installed Co-Agent skill at ${skillDestination}`);
  console.log("Registered Co-Agent MCP. Restart Codex, start a new task, then say: open Co-Agent and bind this task.");
}

async function doctor() {
  const runtime = await readRuntime();
  const checks = {
    node: process.version,
    daemon: await runtimeIsHealthy(runtime),
    codex: spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim() || "not found",
    hostThreadIdAvailable: Boolean(process.env.CODEX_THREAD_ID),
    frontendBuilt: await fs.stat(path.join(packageRoot, "dist", "web", "index.html")).then(() => true, () => false),
    tauriBuilt: await Promise.any([
      fs.stat(path.join(packageRoot, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos", "Co-Agent.app")),
      fs.stat(path.join(packageRoot, "src-tauri", "target", "release", "bundle", "macos", "Co-Agent.app")),
    ]).then(() => true, () => false),
  };
  console.log(JSON.stringify(checks, null, 2));
  if (!checks.frontendBuilt || !checks.tauriBuilt || checks.codex === "not found") process.exitCode = 1;
}

try {
  if (command === "daemon") {
    const { runtime } = await startDaemon();
    console.error(`[co-agent] daemon ready on 127.0.0.1:${runtime.port}`);
  } else if (command === "open") {
    await openApp();
  } else if (command === "setup" && argumentsAfterCommand[0] === "codex") {
    await setupCodex();
  } else if (command === "doctor") {
    await doctor();
  } else if (command === "mcp") {
    const { runMcpServer } = await import("../src/mcp/server.mjs");
    await runMcpServer();
  } else if (command === "acp") {
    const { runAcpServer } = await import("../src/acp/server.mjs");
    await runAcpServer();
  } else {
    console.error("Usage: co-agent [open|daemon|mcp|acp (experimental)|doctor|setup codex]");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`[co-agent] ${error.message || error}`);
  process.exitCode = 1;
}
