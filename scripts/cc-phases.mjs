#!/usr/bin/env node
// CLI for Claude Code to break a large task into ordered PHASES (and subphases)
// and tick them off one at a time. Plans live IN THE PROJECT, not the user
// layer, as a FOLDER per plan with a human-meaningful (English) name:
//
//   .claude/phases/
//     README.md                  <- index / explainer (scaffolded once)
//     <Plan-Title>/              <- one folder per plan, named by its title
//       README.md                <- plan notes + the `CC-task: #N` link (yours to edit)
//       Phase-1.md               <- one file per phase (title, desc, done, subphases)
//       Phase-2.md
//
// Why a folder + file-per-phase: meaningful names instead of an opaque `16.md`,
// and each phase is its own readable, diffable file. The plan's README carries
// the tracker link (`CC-task: #N`) plus any freeform notes on how to run the
// phases — the CLI scaffolds it once and then NEVER overwrites it. The Phase-N.md
// files are the single source of truth for phase state; keep their grammar in
// lockstep with src-tauri/src/phases.rs.
//
// Phase file grammar:
//   # Phase 1: <title>
//   <!-- status: done -->            (present only when the phase is done)
//
//   <optional one-line description>
//
//   - [ ] 1.1 <subphase title> — <subphase text>
//   - [x] 1.2 <subphase title>
//
// `[x]` = done. ` — ` splits an item's title from its optional text. A phase
// locator is its number `N`; a subphase locator is `N.k`.
//
// Commands:
//   create "<English title>" [--task <N>]     make a new plan folder (title → folder
//                                             name, so it's validated English-only)
//   add "<title>" ["<desc>"] [--plan <slug>]              new phase
//   add-sub "<title>" ["<text>"] [--phase <N>] [--plan <slug>]   new subphase
//   done <loc> [--plan <slug>]      loc = N (phase) or N.k (subphase) → done
//   reopen <loc> [--plan <slug>]    → not done
//   edit <loc> [--title "…"] [--desc "…"] [--plan <slug>]
//   delete <loc> [--force] [--plan <slug>]    phase with subphases needs --force
//   verify [--plan <slug>]          integrity self-check
//   list [--plan <slug>] [--json]   one plan, or (no plan, many) the plan index
//
// `--plan <slug>` is the plan's folder name; it's optional when the project has
// exactly one plan. Exit code is non-zero on any error.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import path from "node:path";

// Plans live under the CURRENT project's .claude (this CLI runs in the project
// cwd, exactly where Claude's session is), never in the user/home layer.
function phasesRoot() {
  return path.join(process.cwd(), ".claude", "phases");
}
function planDir(slug) {
  return path.join(phasesRoot(), slug);
}
function phaseFile(slug, n) {
  return path.join(planDir(slug), `Phase-${n}.md`);
}
function planReadme(slug) {
  return path.join(planDir(slug), "README.md");
}

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// ` — ` is the title/text separator; newlines would break the one-line grammar.
function sanitize(s) {
  return String(s ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/ — /g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

// English-only, folder-safe title: letters/digits to start, then letters/digits/
// space/_/- . Enforced because the title becomes a directory name.
const TITLE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
function slugify(title) {
  return title.trim().replace(/\s+/g, "-").replace(/-+/g, "-");
}

// --- markdown <-> phase model -------------------------------------------------

const SUB_RE = /^- \[([ x])\] (\d+)\.(\d+) (.+)$/;
const H1_RE = /^# Phase \d+:\s*(.*)$/;
const DONE_RE = /^<!--\s*status:\s*done\s*-->/;

function splitTitle(rest) {
  const i = rest.indexOf(" — ");
  if (i < 0) return { title: rest.trim(), desc: "" };
  return { title: rest.slice(0, i).trim(), desc: rest.slice(i + 3).trim() };
}

// Parse one Phase-N.md. `num` comes from the filename (authoritative). The H1's
// number is ignored; its text is the title. Lines before the first subphase that
// aren't the heading / done-marker / blank form the (one-line) description.
function parsePhase(text, num) {
  let title = "";
  let done = false;
  const descLines = [];
  const subs = [];
  for (const raw of text.split(/\r?\n/)) {
    const h1 = raw.match(H1_RE);
    if (h1) {
      title = h1[1].trim();
      continue;
    }
    if (DONE_RE.test(raw)) {
      done = true;
      continue;
    }
    const sm = raw.match(SUB_RE);
    if (sm) {
      const { title: st, desc: stext } = splitTitle(sm[4]);
      subs.push({ num: Number(sm[3]), title: st, text: stext, done: sm[1] === "x" });
      continue;
    }
    if (!subs.length && raw.trim() && !raw.startsWith("<!--")) {
      descLines.push(raw.trim());
    }
  }
  return { num, title, desc: descLines.join(" "), done, subs };
}

function box(done) {
  return done ? "[x]" : "[ ]";
}

function serializePhase(phase) {
  const lines = [`# Phase ${phase.num}: ${phase.title}`];
  if (phase.done) lines.push("<!-- status: done -->");
  lines.push("");
  if (phase.desc) lines.push(phase.desc, "");
  for (const s of phase.subs) {
    const text = s.text ? ` — ${s.text}` : "";
    lines.push(`- ${box(s.done)} ${phase.num}.${s.num} ${s.title}${text}`);
  }
  // Trim a trailing blank so files end with exactly one newline.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}

// --- plan IO ------------------------------------------------------------------

function writeAtomic(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

// Plan folder names (every subdirectory of .claude/phases).
function listPlans() {
  let entries;
  try {
    entries = readdirSync(phasesRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

// Resolve which plan a command targets: explicit --plan wins; else the sole plan;
// else it's ambiguous/absent and the caller must say which.
function resolvePlan(flags) {
  if (typeof flags.plan === "string") {
    if (!existsSync(planDir(flags.plan))) fail(`no plan "${flags.plan}"`);
    return flags.plan;
  }
  const plans = listPlans();
  if (plans.length === 1) return plans[0];
  if (plans.length === 0)
    fail("no plans yet — create one: cc-phases create \"<title>\" --task <N>");
  fail(`multiple plans (${plans.join(", ")}) — pass --plan <slug>`);
}

// Phase numbers present in a plan, ascending (from the Phase-<n>.md filenames).
function phaseNums(slug) {
  let entries;
  try {
    entries = readdirSync(planDir(slug));
  } catch {
    return [];
  }
  return entries
    .map((f) => f.match(/^Phase-(\d+)\.md$/))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

function loadPhase(slug, n) {
  return parsePhase(readFileSync(phaseFile(slug, n), "utf8"), n);
}

function loadPlan(slug) {
  const phases = phaseNums(slug).map((n) => loadPhase(slug, n));
  return { slug, ...readPlanMeta(slug), phases };
}

// The plan's title (first H1) and tracker link (`CC-task: #N`) from its README.
function readPlanMeta(slug) {
  let text = "";
  try {
    text = readFileSync(planReadme(slug), "utf8");
  } catch {
    return { title: slug, task: null };
  }
  const title = text.match(/^#\s+(.+)$/m);
  const task = text.match(/CC-task:\s*#?(\d+)/i);
  return {
    title: title ? title[1].trim() : slug,
    task: task ? Number(task[1]) : null,
  };
}

// --- scaffolding (written once, never clobbered) ------------------------------

function ensureRootReadme() {
  const file = path.join(phasesRoot(), "README.md");
  if (existsSync(file)) return;
  writeAtomic(
    file,
    [
      "# Phases",
      "",
      "Plans for large tasks — one **folder per plan** (named by its title), one",
      "**file per phase** (`Phase-N.md`). Each plan's `README.md` holds notes plus",
      "its tracker link (`CC-task: #N`).",
      "",
      "Managed by the cc-phases CLI — mutate through it, not by hand:",
      "",
      '    node <scripts>/cc-phases.mjs create "Plan title" --task <N>',
      '    node <scripts>/cc-phases.mjs add "Phase title" "what done looks like"',
      '    node <scripts>/cc-phases.mjs add-sub "Subphase title" --phase 1',
      "    node <scripts>/cc-phases.mjs done 1.1",
      "    node <scripts>/cc-phases.mjs list",
      "",
    ].join("\n"),
  );
}

// --- arg parsing --------------------------------------------------------------

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[a.slice(2)] = true;
      } else {
        flags[a.slice(2)] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function locate(plan, loc) {
  const m = String(loc).match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) fail(`bad locator "${loc}" — use N (phase) or N.k (subphase)`);
  const phase = plan.phases.find((p) => p.num === Number(m[1]));
  if (!phase) fail(`no phase ${m[1]} in plan "${plan.slug}"`);
  if (m[2] === undefined) return { phase };
  const sub = phase.subs.find((s) => s.num === Number(m[2]));
  if (!sub) fail(`no subphase ${loc} in plan "${plan.slug}"`);
  return { phase, sub };
}

// --- commands -----------------------------------------------------------------

function cmdCreate(args) {
  const { positional, flags } = parseArgs(args);
  const title = String(positional[0] ?? "").trim();
  if (!title) fail('usage: cc-phases create "<English title>" [--task <N>]');
  if (!TITLE_RE.test(title))
    fail(
      `title must be English letters/digits/space/_/- only (it becomes a folder name): "${title}"`,
    );
  const slug = slugify(title);
  if (existsSync(planDir(slug))) fail(`plan "${slug}" already exists`);

  let task = null;
  if (flags.task != null && flags.task !== true) {
    const n = Number(flags.task);
    if (!Number.isInteger(n) || n <= 0) fail("--task must be a positive integer");
    task = n;
  }

  const readme = [
    `# ${title}`,
    "",
    `CC-task: #${task ?? "(none)"}`,
    "",
    "> Notes on this plan — context, decisions, how to run the phases, gotchas.",
    "> Add freely; the cc-phases CLI does NOT overwrite this file after creation.",
    "",
    "Phases live in the sibling `Phase-N.md` files (one per phase). Manage them",
    "with the cc-phases CLI, not by hand.",
    "",
  ].join("\n");
  writeAtomic(planReadme(slug), readme);
  ensureRootReadme();
  process.stdout.write(
    `ok: created plan "${slug}"` +
      (task ? ` (CC-task #${task})` : " (no --task: it won't show on a task card)") +
      `\n`,
  );
}

function cmdAdd(args) {
  if (args[0] === "subphase" || args[0] === "sub") return cmdAddSub(args.slice(1));
  const { positional, flags } = parseArgs(args);
  const title = sanitize(positional[0]);
  if (!title) fail('usage: cc-phases add "<title>" ["<desc>"] [--plan <slug>]');
  const desc = sanitize(positional[1]);
  const slug = resolvePlan(flags);
  const nums = phaseNums(slug);
  const num = (nums.length ? Math.max(...nums) : 0) + 1;
  writeAtomic(phaseFile(slug, num), serializePhase({ num, title, desc, done: false, subs: [] }));
  process.stdout.write(`ok: added Phase ${num} to "${slug}": ${title}\n`);
}

function cmdAddSub(args) {
  const { positional, flags } = parseArgs(args);
  const title = sanitize(positional[0]);
  if (!title)
    fail('usage: cc-phases add-sub "<title>" ["<text>"] [--phase <N>] [--plan <slug>]');
  const text = sanitize(positional[1]);
  const slug = resolvePlan(flags);
  const nums = phaseNums(slug);
  if (!nums.length) fail(`plan "${slug}" has no phases yet`);
  let n;
  if (flags.phase != null && flags.phase !== true) {
    n = Number(flags.phase);
    if (!nums.includes(n)) fail(`no phase ${flags.phase} in plan "${slug}"`);
  } else {
    n = Math.max(...nums); // default: the last phase
  }
  const phase = loadPhase(slug, n);
  const k = (phase.subs.length ? Math.max(...phase.subs.map((s) => s.num)) : 0) + 1;
  phase.subs.push({ num: k, title, text, done: false });
  writeAtomic(phaseFile(slug, n), serializePhase(phase));
  process.stdout.write(`ok: added subphase ${n}.${k} to "${slug}": ${title}\n`);
}

function setDone(args, done) {
  const { positional, flags } = parseArgs(args);
  const loc = positional[0];
  if (!loc) fail(`usage: cc-phases ${done ? "done" : "reopen"} <loc> [--plan <slug>]`);
  const slug = resolvePlan(flags);
  const plan = loadPlan(slug);
  const { phase, sub } = locate(plan, loc);
  if (sub) {
    sub.done = done;
  } else {
    phase.done = done;
    for (const s of phase.subs) s.done = done; // a phase's box covers its subphases
  }
  writeAtomic(phaseFile(slug, phase.num), serializePhase(phase));
  process.stdout.write(`ok: ${loc} → ${done ? "done" : "todo"} ("${slug}")\n`);
}

function cmdEdit(args) {
  const { positional, flags } = parseArgs(args);
  const loc = positional[0];
  if (!loc) fail('usage: cc-phases edit <loc> [--title "…"] [--desc "…"] [--plan <slug>]');
  const slug = resolvePlan(flags);
  const plan = loadPlan(slug);
  const { phase, sub } = locate(plan, loc);
  const target = sub ?? phase;
  let changed = false;
  if (typeof flags.title === "string") {
    target.title = sanitize(flags.title);
    changed = true;
  }
  const body =
    typeof flags.desc === "string" ? flags.desc
    : typeof flags.text === "string" ? flags.text
    : null;
  if (body !== null) {
    if (sub) sub.text = sanitize(body);
    else phase.desc = sanitize(body);
    changed = true;
  }
  if (!changed) fail("nothing to edit — pass --title and/or --desc");
  writeAtomic(phaseFile(slug, phase.num), serializePhase(phase));
  process.stdout.write(`ok: edited ${loc} ("${slug}")\n`);
}

function cmdDelete(args) {
  const { positional, flags } = parseArgs(args);
  const loc = positional[0];
  if (!loc) fail("usage: cc-phases delete <loc> [--force] [--plan <slug>]");
  const slug = resolvePlan(flags);
  const plan = loadPlan(slug);
  const { phase, sub } = locate(plan, loc);
  if (sub) {
    phase.subs = phase.subs.filter((s) => s !== sub);
    writeAtomic(phaseFile(slug, phase.num), serializePhase(phase));
  } else {
    if (phase.subs.length && !flags.force)
      fail(`Phase ${loc} has ${phase.subs.length} subphase(s) — pass --force`);
    rmSync(phaseFile(slug, phase.num));
  }
  process.stdout.write(`ok: deleted ${loc} ("${slug}")\n`);
}

// Read-only integrity check: every phase file parses, subphase numbers are unique
// within a phase, each phase round-trips, and the README carries a CC-task link.
function cmdVerify(args) {
  const { flags } = parseArgs(args);
  const slug = resolvePlan(flags);
  const plan = loadPlan(slug);
  const problems = [];
  if (plan.task == null)
    problems.push('README has no "CC-task: #N" link — it won\'t show on a task card');
  for (const p of plan.phases) {
    const seen = new Set();
    for (const s of p.subs) {
      if (seen.has(s.num)) problems.push(`duplicate subphase ${p.num}.${s.num}`);
      seen.add(s.num);
    }
    const round = parsePhase(serializePhase(p), p.num);
    if (JSON.stringify(round) !== JSON.stringify(p))
      problems.push(`Phase-${p.num}.md does not round-trip`);
  }
  if (problems.length)
    fail(`verify FAILED for "${slug}":\n  - ` + problems.join("\n  - "));
  const subs = plan.phases.reduce((n, p) => n + p.subs.length, 0);
  process.stdout.write(
    `ok: "${slug}" valid — CC-task #${plan.task}, ${plan.phases.length} phase(s), ${subs} subphase(s)\n`,
  );
}

function cmdList(args) {
  const { flags } = parseArgs(args);
  // No --plan and several plans → show the plan index instead of one plan.
  if (typeof flags.plan !== "string" && listPlans().length > 1) {
    const plans = listPlans().map((s) => loadPlan(s));
    if (flags.json) {
      process.stdout.write(JSON.stringify(plans, null, 2) + "\n");
      return;
    }
    for (const p of plans) {
      const done = p.phases.filter((x) => x.done).length;
      process.stdout.write(
        `${p.slug}  (CC-task #${p.task ?? "?"}, ${done}/${p.phases.length} phases)\n`,
      );
    }
    return;
  }
  const slug = resolvePlan(flags);
  const plan = loadPlan(slug);
  if (flags.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return;
  }
  const mark = (d) => (d ? "[x]" : "[ ]");
  const out = [`${plan.slug} (CC-task #${plan.task ?? "?"}):`];
  for (const p of plan.phases) {
    out.push(`  ${mark(p.done)} ${p.num}. ${p.title}${p.desc ? ` — ${p.desc}` : ""}`);
    for (const s of p.subs) {
      out.push(`      ${mark(s.done)} ${p.num}.${s.num} ${s.title}${s.text ? ` — ${s.text}` : ""}`);
    }
  }
  process.stdout.write(out.join("\n") + "\n");
}

function usage(code) {
  process.stdout.write(
    "cc-phases - break a task into ordered phases (folder per plan in <project>/.claude/phases/)\n\n" +
      '  create "<English title>" [--task <N>]   new plan folder (title → folder name)\n' +
      '  add "<title>" ["<desc>"] [--plan <slug>]               new phase\n' +
      '  add-sub "<title>" ["<text>"] [--phase <N>] [--plan <slug>]\n' +
      "  done <loc> [--plan <slug>]      loc = N (phase) or N.k (subphase)\n" +
      "  reopen <loc> [--plan <slug>]\n" +
      '  edit <loc> [--title "…"] [--desc "…"] [--plan <slug>]\n' +
      "  delete <loc> [--force] [--plan <slug>]\n" +
      "  verify [--plan <slug>]          integrity self-check\n" +
      "  list [--plan <slug>] [--json]\n\n" +
      "--plan is the plan folder name; optional when only one plan exists.\n",
  );
  process.exit(code);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "create":
    cmdCreate(rest);
    break;
  case "add":
    cmdAdd(rest);
    break;
  case "add-sub":
  case "addsub":
    cmdAddSub(rest);
    break;
  case "done":
    setDone(rest, true);
    break;
  case "reopen":
  case "undone":
    setDone(rest, false);
    break;
  case "edit":
    cmdEdit(rest);
    break;
  case "delete":
  case "rm":
    cmdDelete(rest);
    break;
  case "verify":
    cmdVerify(rest);
    break;
  case "list":
    cmdList(rest);
    break;
  case undefined:
  case "-h":
  case "--help":
  case "help":
    usage(0);
    break;
  default:
    process.stderr.write(`unknown command: ${cmd}\n`);
    usage(1);
}
