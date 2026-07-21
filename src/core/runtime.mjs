import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimePath } from "./paths.mjs";

export async function readRuntime() {
  try {
    return JSON.parse(await fs.readFile(runtimePath, "utf8"));
  } catch {
    return null;
  }
}

export async function runtimeIsHealthy(runtime) {
  if (!runtime?.port || !runtime?.token) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureDaemon({ cliPath } = {}) {
  const existing = await readRuntime();
  if (await runtimeIsHealthy(existing)) return existing;
  const resolvedCli = cliPath || fileURLToPath(new URL("../../bin/co-agent.mjs", import.meta.url));
  const child = spawn(process.execPath, [resolvedCli, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CO_AGENT_DAEMON_CHILD: "1" },
  });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const runtime = await readRuntime();
    if (await runtimeIsHealthy(runtime)) return runtime;
  }
  throw new Error("Co-Agent daemon did not become ready");
}

export async function apiRequest(runtime, pathname, options = {}) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${runtime.token}`,
    ...(options.headers || {}),
  };
  const response = await fetch(`http://127.0.0.1:${runtime.port}${pathname}`, {
    ...options,
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Co-Agent request failed: ${response.status}`);
  return body;
}
