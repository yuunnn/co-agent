import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { sessionRoot } from "./paths.mjs";

const TEXT_EXTENSIONS = new Set([
  ".css", ".csv", ".go", ".html", ".js", ".json", ".jsx", ".log", ".md",
  ".mjs", ".py", ".rs", ".tex", ".toml", ".ts", ".tsv", ".tsx", ".txt", ".xml",
  ".yaml", ".yml",
]);

function safeName(value) {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "source";
}

function run(command, args, { cwd, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out while preparing evidence`));
    }, timeoutMs);
    timer.unref();
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with ${code}`));
    });
  });
}

function pageMarkedText(raw) {
  const pages = raw.split("\f");
  if (pages.at(-1)?.trim() === "") pages.pop();
  return {
    pages: pages.length,
    text: pages.map((page, index) => `--- Page ${index + 1} ---\n${page.trimEnd()}`).join("\n\n"),
  };
}

function unique(values) {
  return [...new Set(values)];
}

export function discoverEvidencePaths(objective = "", cwd = process.cwd()) {
  const quoted = [...objective.matchAll(/["'](\/[^"']+)["']/g)].map((match) => match[1]);
  const bare = [...objective.matchAll(/(?:^|\s)(\/[^\s"'`]+?\.(?:pdf|txt|md|tex|toml|json|csv|tsv|yaml|yml))(?:[),.;:]?)(?=\s|$)/gi)]
    .map((match) => match[1]);
  return unique([...quoted, ...bare].map((candidate) => path.resolve(cwd, candidate)));
}

export function sanitizeEvidenceReferences(value = "", evidence = null) {
  let sanitized = String(value || "");
  for (const source of evidence?.sources || []) {
    if (source.originalPath) sanitized = sanitized.split(source.originalPath).join(source.name);
    if (source.requestedPath) sanitized = sanitized.split(source.requestedPath).join(source.name);
  }
  return sanitized;
}

export async function prepareEvidencePacket({
  sessionId,
  cwd,
  objective = "",
  evidencePaths = [],
  mode = "auto",
}) {
  const discovered = evidencePaths.length ? evidencePaths : discoverEvidencePaths(objective, cwd);
  const resolvedMode = mode === "auto" ? (discovered.length ? "sealed" : "workspace") : mode;
  if (!["prompt", "workspace", "sealed"].includes(resolvedMode)) throw new Error(`Unsupported evidence mode: ${resolvedMode}`);
  if (resolvedMode !== "sealed") {
    return {
      mode: resolvedMode,
      status: resolvedMode === "prompt" ? "not_required" : "workspace",
      sources: [],
      preparedAt: new Date().toISOString(),
    };
  }
  if (!discovered.length) throw new Error("Sealed evidence mode requires at least one evidence path");

  const packetId = randomUUID();
  const packetPath = path.join(sessionRoot(sessionId), "artifacts", "evidence", packetId);
  await fs.mkdir(packetPath, { recursive: true });
  const sources = [];
  const aggregate = [
    `CO-AGENT SEALED EVIDENCE PACKET ${packetId}`,
    "Use only the material below. Original workspace paths are intentionally unavailable.",
  ];
  try {
    for (const [index, candidate] of discovered.entries()) {
      const requestedPath = path.resolve(cwd, candidate);
      const originalPath = await fs.realpath(requestedPath);
      const stat = await fs.stat(originalPath);
      if (!stat.isFile()) throw new Error(`Evidence source is not a file: ${originalPath}`);
      const extension = path.extname(originalPath).toLowerCase();
      if (extension !== ".pdf" && !TEXT_EXTENSIONS.has(extension)) {
        throw new Error(`Unsupported evidence type ${extension || "without extension"}: ${originalPath}`);
      }
      const number = String(index + 1).padStart(2, "0");
      const name = path.basename(originalPath);
      const packetFile = `source-${number}-${safeName(name)}`;
      const packetFilePath = path.join(packetPath, packetFile);
      const bytes = await fs.readFile(originalPath);
      await fs.writeFile(packetFilePath, bytes);
      let extractedFile = packetFile;
      let extractedText;
      let pages = null;
      if (extension === ".pdf") {
        const rawTextPath = path.join(packetPath, `.source-${number}.raw.txt`);
        await run(process.env.PDFTOTEXT_BIN || "pdftotext", ["-layout", "-enc", "UTF-8", packetFilePath, rawTextPath], { cwd: packetPath });
        const marked = pageMarkedText(await fs.readFile(rawTextPath, "utf8"));
        extractedFile = `source-${number}-${safeName(path.basename(name, extension))}.txt`;
        extractedText = marked.text;
        pages = marked.pages;
        await fs.writeFile(path.join(packetPath, extractedFile), `${extractedText}\n`, "utf8");
        await fs.unlink(rawTextPath);
      } else {
        extractedText = bytes.toString("utf8");
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      sources.push({
        id: `source-${number}`,
        name,
        kind: extension === ".pdf" ? "pdf" : "text",
        packetFile,
        extractedFile,
        originalPath,
        requestedPath,
        sizeBytes: bytes.length,
        sha256,
        pages,
      });
      aggregate.push(`\n===== ${name} (${sha256.slice(0, 12)}) =====\n`, extractedText);
    }

    const manifest = {
      packetId,
      sealed: true,
      createdAt: new Date().toISOString(),
      sources: sources.map(({ originalPath: _originalPath, requestedPath: _requestedPath, ...source }) => source),
    };
    await fs.writeFile(path.join(packetPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(packetPath, "council-evidence.txt"), `${aggregate.join("\n").trim()}\n`, "utf8");
    await fs.writeFile(path.join(packetPath, "task.txt"), `${sanitizeEvidenceReferences(objective, { sources })}\n`, "utf8");
    const entries = await fs.readdir(packetPath);
    await Promise.all(entries.map((entry) => fs.chmod(path.join(packetPath, entry), 0o444)));
    await fs.chmod(packetPath, 0o555);
    return {
      mode: "sealed",
      status: "ready",
      packetId,
      packetPath,
      aggregateFile: "council-evidence.txt",
      sourceCount: sources.length,
      sources,
      preparedAt: manifest.createdAt,
    };
  } catch (error) {
    await fs.chmod(packetPath, 0o755).catch(() => {});
    await fs.rm(packetPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function readSealedEvidence(evidence, { maxCharacters = 220_000 } = {}) {
  if (evidence?.mode !== "sealed" || evidence.status !== "ready") return "";
  const text = await fs.readFile(path.join(evidence.packetPath, evidence.aggregateFile), "utf8");
  if (text.length > maxCharacters) {
    throw new Error(`Sealed evidence is ${text.length.toLocaleString()} characters; direct API limit is ${maxCharacters.toLocaleString()}`);
  }
  return text;
}
