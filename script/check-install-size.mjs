import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const limitBytes = 50 * 1024 * 1024;
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "co-agent-size-check-"));

function run(command, args, cwd = projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"));
      reject(new Error(Buffer.concat(stderr).toString("utf8") || `${command} exited with ${code}`));
    });
  });
}

async function directorySize(root) {
  const entry = await fs.lstat(root);
  const allocated = typeof entry.blocks === "number" ? entry.blocks * 512 : entry.size;
  if (!entry.isDirectory()) return allocated;
  const children = await fs.readdir(root);
  const sizes = await Promise.all(children.map((child) => directorySize(path.join(root, child))));
  return allocated + sizes.reduce((total, size) => total + size, 0);
}

try {
  const packed = JSON.parse(await run("npm", ["pack", "--pack-destination", temporaryRoot, "--json"]));
  const archive = path.join(temporaryRoot, packed[0].filename);
  const installRoot = path.join(temporaryRoot, "install");
  await run("npm", ["install", "--prefix", installRoot, "--omit=dev", archive]);
  const installedBytes = await directorySize(installRoot);
  const installedMiB = installedBytes / 1024 / 1024;
  if (installedBytes > limitBytes) {
    throw new Error(`Installed package is ${installedMiB.toFixed(1)} MiB; the product limit is 50 MiB.`);
  }
  console.log(`Installed package size: ${installedMiB.toFixed(1)} MiB (limit: 50 MiB).`);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
