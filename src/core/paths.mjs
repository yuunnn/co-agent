import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);

export const packageRoot = path.resolve(path.dirname(currentFile), "../..");
export const dataRoot = path.resolve(
  process.env.CO_AGENT_HOME || path.join(os.homedir(), ".co-agent"),
);
export const sessionsRoot = path.join(dataRoot, "sessions");
export const archivedSessionsRoot = path.join(dataRoot, "archived-sessions");
export const runtimePath = path.join(dataRoot, "runtime.json");
export const configPath = path.join(dataRoot, "config.json");
export const secretsPath = path.join(dataRoot, "secrets.json");
export const webRoot = path.join(packageRoot, "dist", "web");
export const bundledSkillRoot = path.join(packageRoot, "skill", "co-agent");

export function sessionRoot(sessionId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error("Invalid Co-Agent session id");
  }
  return path.join(sessionsRoot, sessionId);
}
