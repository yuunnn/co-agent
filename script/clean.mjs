import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const targetRoot = path.join(projectRoot, "src-tauri", "target");
const compilerCacheRoot = process.env.CO_AGENT_CARGO_TARGET_DIR
  || (process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches", "co-agent", "cargo-target")
    : path.join(os.tmpdir(), "co-agent-cargo-target"));
const appRoot = path.join(targetRoot, "release", "bundle", "macos", "Co-Agent.app");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "co-agent-clean-"));
const savedApp = path.join(temporaryRoot, "Co-Agent.app");

try {
  try {
    await fs.cp(appRoot, savedApp, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  for (const relativePath of ["node_modules", "tmp", "src-tauri/target"]) {
    await fs.rm(path.join(projectRoot, relativePath), { recursive: true, force: true });
  }
  await fs.rm(compilerCacheRoot, { recursive: true, force: true });

  try {
    await fs.access(savedApp);
    await fs.mkdir(path.dirname(appRoot), { recursive: true });
    await fs.cp(savedApp, appRoot, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Removed dependency and external compiler caches; preserved the packaged Co-Agent.app when present.");
