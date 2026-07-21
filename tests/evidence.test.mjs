import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("sealed evidence packets contain only copied evidence and redacted provenance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "co-agent-evidence-test-"));
  process.env.CO_AGENT_HOME = root;
  let packetPath;
  t.after(async () => {
    delete process.env.CO_AGENT_HOME;
    if (packetPath) await fs.chmod(packetPath, 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, "original");
  await fs.mkdir(sourceRoot, { recursive: true });
  const sourcePath = path.join(sourceRoot, "review.txt");
  await fs.writeFile(sourcePath, "Evidence line one.\nEvidence line two.\n", "utf8");
  const { prepareEvidencePacket, readSealedEvidence } = await import(`../src/core/evidence.mjs?test=${Date.now()}`);
  const evidence = await prepareEvidencePacket({
    sessionId: "sealed-test",
    cwd: sourceRoot,
    objective: `Review only ${sourcePath}`,
    evidencePaths: [sourcePath],
    mode: "sealed",
  });
  packetPath = evidence.packetPath;
  assert.equal(evidence.mode, "sealed");
  assert.equal(evidence.sourceCount, 1);
  assert.equal(evidence.sources[0].originalPath, await fs.realpath(sourcePath));
  const packetFiles = await fs.readdir(evidence.packetPath);
  assert.deepEqual(packetFiles.sort(), ["council-evidence.txt", "manifest.json", "source-01-review.txt", "task.txt"]);
  const manifest = await fs.readFile(path.join(evidence.packetPath, "manifest.json"), "utf8");
  const task = await fs.readFile(path.join(evidence.packetPath, "task.txt"), "utf8");
  assert.doesNotMatch(manifest, new RegExp(sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(task, new RegExp(sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(await readSealedEvidence(evidence), /Evidence line two/);
  assert.equal((await fs.stat(path.join(evidence.packetPath, "manifest.json"))).mode & 0o777, 0o444);
});

test("sealed evidence accepts TOML sources and discovers absolute TOML paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "co-agent-toml-test-"));
  process.env.CO_AGENT_HOME = root;
  let packetPath;
  t.after(async () => {
    delete process.env.CO_AGENT_HOME;
    if (packetPath) await fs.chmod(packetPath, 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const sourcePath = path.join(root, "Cargo.toml");
  await fs.writeFile(sourcePath, "[package]\nname = \"co-agent-demo\"\n", "utf8");
  const module = await import(`../src/core/evidence.mjs?toml=${Date.now()}`);
  assert.deepEqual(module.discoverEvidencePaths(`Review ${sourcePath}`, root), [sourcePath]);
  const evidence = await module.prepareEvidencePacket({
    sessionId: "toml-test",
    cwd: root,
    objective: `Review ${sourcePath}`,
    mode: "sealed",
  });
  packetPath = evidence.packetPath;
  assert.equal(evidence.sources[0].name, "Cargo.toml");
  assert.match(await module.readSealedEvidence(evidence), /co-agent-demo/);
});
