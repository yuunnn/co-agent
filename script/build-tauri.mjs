import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const cacheRoot = process.env.CO_AGENT_CARGO_TARGET_DIR
  || (process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches", "co-agent", "cargo-target")
    : path.join(os.tmpdir(), "co-agent-cargo-target"));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, CARGO_TARGET_DIR: cacheRoot },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

await fs.mkdir(cacheRoot, { recursive: true });
await run("npm", ["exec", "--", "tauri", "build", "--bundles", "app"]);

if (process.platform === "darwin") {
  const builtApp = path.join(cacheRoot, "release", "bundle", "macos", "Co-Agent.app");
  const packagedApp = path.join(projectRoot, "src-tauri", "target", "release", "bundle", "macos", "Co-Agent.app");
  await fs.rm(packagedApp, { recursive: true, force: true });
  await fs.mkdir(path.dirname(packagedApp), { recursive: true });
  await fs.cp(builtApp, packagedApp, { recursive: true });
  console.log(`Staged Co-Agent.app in the project; compiler cache remains outside the repository at ${cacheRoot}.`);
}
