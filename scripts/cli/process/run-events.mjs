import { appendFileSync, mkdirSync, readFileSync, statSync, watch } from "node:fs";
import path from "node:path";

const changeId = (value) => {
  const text = String(value?.number ?? value ?? "").trim();
  return text ? (text.startsWith("c#") ? text : `c#${text.replace(/^#/, "")}`) : "";
};

const taskId = (value) => {
  const text = String(value?.number ?? value ?? "").trim();
  return text ? (text.startsWith("t#") ? text : `t#${text.replace(/^#/, "")}`) : "";
};

export function runEventsPath(runLogFile) {
  return path.join(path.dirname(runLogFile), "run-events.jsonl");
}

function defaultEventsPath() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(appData, "com.claude-usage-tracker.app", "run-events.jsonl");
}

export function appendRunEvent(event, file = defaultEventsPath()) {
  if (!event || !file) return false;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
    return true;
  } catch {
    return false;
  }
}

export function formatRunEvent(event) {
  const prefix = [changeId(event?.change), taskId(event?.task)].filter(Boolean).join(" ");
  const attempt = event?.attempt == null ? "" : ` attempt ${event.attempt}/${event.limit ?? "-"}`;
  const kind = String(event?.kind || "event");
  if (kind === "review") {
    const counts = event.counts || {};
    return `${prefix}${attempt}: review high ${counts.high || 0}, medium ${counts.medium || 0}`.trim();
  }
  if (kind === "verify") return `${prefix}${attempt}: verify ${event.ok ? "ok" : "issue"}`.trim();
  if (kind === "rollback") return `${prefix}${attempt}: rollback to ${event.to ?? "previous attempt"}`.trim();
  if (kind === "park") return `${prefix}: park ${event.park_kind || event.stop_kind || "unknown"}${event.reason ? ` — ${event.reason}` : ""}`.trim();
  if (kind === "step_start") return `${prefix}${attempt}: step start${event.route ? ` (${event.route})` : ""}`.trim();
  if (kind === "worker_done") return `${prefix}${attempt}: worker done${typeof event.cost === "number" ? ` $${event.cost}` : ""}`.trim();
  if (kind === "run_start" || kind === "run_end") return `${changeId(event?.change)}: ${kind.replace("_", " ")}`.trim();
  if (kind === "escalate") return `${prefix}${attempt}: escalate${event.route ? ` (${event.route})` : ""}`.trim();
  return `${prefix}${attempt}: ${kind}`.trim();
}

export function watchRunEvents({ change, file, from, onLine = (line) => process.stdout.write(line + "\n"), signal } = {}) {
  const expected = changeId(change);
  mkdirSync(path.dirname(file), { recursive: true });
  let offset = from === "start" ? 0 : (() => { try { return statSync(file).size; } catch { return 0; } })();
  return new Promise((resolve) => {
    let closed = false;
    let watcher;
    let poll;
    const close = () => {
      if (closed) return;
      closed = true;
      watcher?.close();
      clearInterval(poll);
      signal?.removeEventListener?.("abort", close);
      resolve();
    };
    const read = () => {
      let raw;
      try { raw = readFileSync(file, "utf8"); } catch { return; }
      if (Buffer.byteLength(raw) < offset) offset = 0;
      const next = Buffer.from(raw).subarray(offset).toString("utf8");
      offset = Buffer.byteLength(raw);
      for (const line of next.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (changeId(event.change) !== expected) continue;
        onLine(formatRunEvent(event), event);
        if (event.kind === "park" || event.kind === "run_end") return close();
      }
    };
    signal?.addEventListener?.("abort", close, { once: true });
    try { watcher = watch(path.dirname(file), { persistent: true }, (_, name) => { if (!name || String(name) === path.basename(file)) read(); }); } catch {}
    poll = setInterval(read, 1000);
    read();
  });
}
