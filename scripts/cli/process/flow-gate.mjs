import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { flowDeclared, supportedFlowExtensions } from "./graph-rules.mjs";

const tailLines = (value, count = 60) => {
  const lines = String(value ?? "").trim().split(/\r?\n/);
  return lines.length <= count ? lines.join("\n") : lines.slice(-count).join("\n");
};

const unsupportedProduces = (task) => (Array.isArray(task?.produces) ? task.produces : [])
  .map((file) => String(file || "").trim().replace(/\\/g, "/"))
  .filter((file) => file && !supportedFlowExtensions.some((extension) => file.toLowerCase().endsWith(extension)))
  .map((file) => ({ kind: "unsupported-produce", file, method: null, reason: "flowcheck does not inspect this file type" }));

function runExe(exe, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile(exe, args, { cwd, encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code ?? (err.killed ? 2 : 1)) : 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

export async function runFlowGate({ task, cwd, timeoutMs, exe, runCmd = runExe }) {
  const started = Date.now();
  const finish = (status, extra = {}) => ({ status, duration_ms: Date.now() - started, coverage: [], unchecked: unsupportedProduces(task), ...extra });
  if (!flowDeclared(task?.flow))
    return finish("cannot", { reason: "flow gate requires a method delta or a list of them" });
  if (!task?.step_base) return finish("cannot", { reason: "flow declared but no step_base was recorded before the step ran" });
  if (!exe || !fs.existsSync(exe)) return finish("cannot", { reason: `flowcheck executable is unavailable: ${exe || "not configured"}` });

  const spec = Array.isArray(task.flow) ? task.flow : [task.flow];
  const specPath = path.join(os.tmpdir(), `flow-gate-${process.pid}-${randomUUID()}.json`);
  try {
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const args = ["--spec", specPath, "--repo", cwd, "--base", task.step_base, "--coverage", "shadow", "--diagram", "result"];
    const result = await runCmd(exe, args, cwd, timeoutMs);
    const output = [result?.stdout, result?.stderr].filter((v) => String(v || "").trim()).join("\n");
    let parsed = {};
    try { parsed = JSON.parse(result?.stdout || "{}"); } catch {}
    const unchecked = [...(Array.isArray(parsed.unchecked) ? parsed.unchecked : []), ...unsupportedProduces(task)];
    const coverage = parsed?.coverage?.findings ?? parsed?.coverage ?? [];
    const code = Number(result?.code);
    const diagram = typeof parsed?.diagram === "string" ? parsed.diagram : null;
    if (code === 0) return finish("pass", { reason: null, coverage, unchecked, diagram });
    if (code === 2) return finish("cannot", { reason: tailLines(output) || "flowcheck cannot inspect this change", coverage, unchecked, diagram });
    return finish("issue", { reason: tailLines(output) || "flowcheck found a flow issue", coverage, unchecked, diagram });
  } catch (err) {
    return finish("cannot", { reason: `flow gate crashed: ${(err && err.message) || err}` });
  } finally {
    try { fs.rmSync(specPath, { force: true }); } catch {}
  }
}
