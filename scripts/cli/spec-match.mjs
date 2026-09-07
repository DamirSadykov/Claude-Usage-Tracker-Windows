// `cli spec match "<текст>"` — which section of the registry, IF ANY, a piece
// of free text is about (t#342). The question it answers is asked at planning
// time, before a task is taken: "есть ли под это спека". Three answers, and the
// third is the one the command exists for:
//
//   • эти разделы — задача их задевает, прочитай и слинкуй;
//   • этот раздел уже слинкован — не открытие, сверка;
//   • раздела под это НЕТ — повод завести новый или сказать, почему не надо.
//
// The last answer is why nothing here falls back to "best of what we have":
// a matcher that always names a section teaches you to ignore it, and the
// missing-section case is exactly the one a session cannot notice by itself.
//
// Purely local lexical matching — no embeddings, no index, no external service.
// The registry is two files and a few dozen sections; anything heavier would be
// a dependency bought to rank 26 candidates. It is an ADVISOR: it blocks
// nothing, writes nothing, and its precision is unmeasured (see MIN_SCORE).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { listDomainIds, loadDomain, resolveRoot, resolveAddress } from "./spec.mjs";
import { roamingBase } from "./settings.mjs";

// Letters and digits only, the same normalisation the handoff guard uses on a
// baton (`stop-hook.mjs::norm`) — punctuation, markdown and code fences all
// dissolve into word boundaries.
const WORD_RE = /[\p{L}\p{N}]+/gu;
const MIN_TOKEN = 3;

// Russian inflection lives almost entirely in the tail, so a suffix strip is
// enough to make «раздел», «раздела» and «разделов» the same term. This is not
// a stemmer and does not pretend to be one: it is wrong on irregular forms
// («окон» ≠ «окн»), and being wrong there costs a missed hit, never a false
// address. The floor of 3 characters keeps it from eating short roots.
const RU_ENDINGS = [
  "иями", "ями", "ами", "ыми", "ими", "ого", "его", "ому", "ему", "ешь", "ете",
  "ах", "ях", "ам", "ям", "ов", "ев", "ей", "ий", "ый", "ая", "яя", "ое", "ые",
  "ие", "ой", "ом", "ем", "ую", "юю", "ет", "ут", "ют", "ат", "ят", "ла", "ло",
  "ли", "ть", "ся",
  "а", "я", "у", "ю", "е", "и", "ы", "о",
].sort((a, b) => b.length - a.length);
const STEM_FLOOR = 3;

// Words that carry no subject matter. Deliberately short: the idf weighting
// below already zeroes anything that occurs in every section, so a long stop
// list would only be a second, hand-maintained copy of what the corpus says
// about itself.
const STOP = new Set([
  "это", "эта", "этот", "эти", "или", "если", "как", "что", "чтобы", "тот",
  "так", "там", "тут", "уже", "ещё", "еще", "все", "всё", "весь", "для", "при",
  "над", "под", "про", "без", "его", "her", "the", "and", "for", "not", "but",
  "надо", "нужно", "может", "можно", "быть", "есть", "был", "была", "было",
  "который", "которая", "которое", "которые", "когда", "потом", "затем",
  "очень", "просто", "тоже", "также", "либо", "нет", "да", "мы", "он", "она",
]);

export function stem(word) {
  const w = String(word).toLowerCase();
  if (/^[a-z0-9]+$/.test(w)) {
    // ASCII terms here are identifiers and file names — leave them alone except
    // for a plural `s`, which is the one inflection they do carry (hook/hooks).
    return w.length >= 5 && w.endsWith("s") && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w;
  }
  for (const end of RU_ENDINGS) {
    if (w.endsWith(end) && w.length - end.length >= STEM_FLOOR) return w.slice(0, -end.length);
  }
  return w;
}

// [{word, term}] — the original word is kept so the answer can show WHAT
// matched in the reader's own words instead of in stems.
export function tokenize(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(WORD_RE)) {
    const word = m[0].toLowerCase();
    if (word.length < MIN_TOKEN || STOP.has(word)) continue;
    out.push({ word, term: stem(word) });
  }
  return out;
}

// term → the first spelling of it seen in the text.
export function terms(text) {
  const map = new Map();
  for (const { word, term } of tokenize(text)) if (!map.has(term)) map.set(term, word);
  return map;
}

const termSet = (text) => new Set(tokenize(text).map((t) => t.term));

// Every section of the registry as two bags of terms. The heading bag holds the
// domain id, the slug and the title — the three things an author chose as the
// NAME of the subject, which is why a hit there weighs more than a hit in prose.
// An external domain's stub contributes its headings and no prose: that is what
// it has, and half a section is a better candidate than none.
// A section broken into anchors (t#358) contributes its UNITS, not itself. The
// score is the share of the query's significant mass a document covers, so a
// long section of mixed subjects dilutes every query against it — the failure
// that put the right section under the threshold on anything longer than a
// sentence. A unit is one subject in a handful of lines, which is what the
// share was ever meaningful over. The section's own name still travels in the
// unit's heading bag: the slug is half of what an author called the subject.
//
// The lead-in prose before the first anchor goes with the section entry only
// when there are no anchors at all; a section that HAS units is represented by
// them, or a query would match both the container and its contents and the two
// would compete for the same first place.
export function buildCorpus(root = resolveRoot()) {
  const sections = [];
  for (const id of listDomainIds(root)) {
    const dom = loadDomain(id, root);
    if (dom.error) continue;
    for (const [slug, h] of dom.headings) {
      const part = (dom.sections[slug] || {}).part || "";
      const anchors = h.anchors ?? [];
      if (!anchors.length) {
        sections.push({
          address: `${id}#${slug}`,
          domain: id,
          slug,
          title: h.title,
          part,
          heading: termSet(`${id} ${slug} ${h.title}`),
          prose: termSet(h.prose.join(" ")),
        });
        continue;
      }
      for (const a of anchors) {
        sections.push({
          address: `${id}#${slug}/${a.slug}`,
          domain: id,
          slug,
          anchor: a.slug,
          title: a.title,
          section: h.title,
          part,
          heading: termSet(`${id} ${slug} ${h.title} ${a.slug} ${a.title}`),
          prose: termSet(a.prose.join(" ")),
        });
      }
    }
  }
  return sections;
}

// idf over sections, not documents: a term in EVERY section says nothing about
// which one to read, and log(N/df) makes it say exactly nothing (weight 0).
// A term the registry has never seen gets the maximum weight and is counted in
// the denominator only — a query full of words no section knows must score LOW,
// because that is what "спеки под это нет" looks like arithmetically.
export function idfOver(corpus) {
  const df = new Map();
  for (const s of corpus) for (const t of new Set([...s.heading, ...s.prose])) df.set(t, (df.get(t) || 0) + 1);
  const n = corpus.length || 1;
  return (t) => Math.log(n / (df.get(t) || 1));
}

const HEADING_WEIGHT = 3;

// score = Σ idf(hit)·weight / Σ idf(query term). 1.0 means every informative
// word of the query is somewhere in this section's prose; 3.0 that they are all
// in its heading. Nothing normalises by section length on purpose — a long
// section is not a worse answer, and dividing by its size would hand the ranking
// to the shortest stubs.
export function scoreSection(query, section, idf) {
  let hit = 0;
  let total = 0;
  const heading = [];
  const prose = [];
  for (const [term, word] of query) {
    const w = idf(term);
    if (w <= 0) continue; // occurs in every section — carries no signal
    total += w;
    if (section.heading.has(term)) {
      hit += w * HEADING_WEIGHT;
      heading.push(word);
    } else if (section.prose.has(term)) {
      hit += w;
      prose.push(word);
    }
  }
  return { score: total > 0 ? hit / total : 0, total, heading, prose };
}

// The bar a candidate has to clear to be shown at all.
//
// HONEST ABOUT THIS NUMBER. It was fitted on twelve points and nothing else:
// the 9 tasks on this board that already carry a `spec` link (their own text
// against their own section scored 0.30 … 0.75) and 3 deliberately off-topic
// texts (best score 0.29). So the two classes are ONE HUNDREDTH apart, on a
// dozen samples from one repository — that is not a separation, it is a
// coincidence with a decimal point. Precision on anything else is unmeasured.
//
// Which is why the miss is reported anyway: a "нет раздела" answer names the
// best near miss and its score, so a true positive sitting at 0.29 is labelled
// below-the-bar rather than hidden. The command advises; the bar decides only
// what gets top billing, never what the reader is allowed to see.
export const MIN_SCORE = 0.3;
const DEFAULT_LIMIT = 3;

// An address written out in the text (`tasks#done-gate`) is not a guess — the
// author already said which section this is about. Such a hit is reported
// separately from the lexical ranking and never suppressed by the threshold.
const ADDRESS_RE = /\b([a-z][a-z0-9-]*)#([a-z][a-z0-9-]*)\b/gi;

export function addressesIn(text, root = resolveRoot()) {
  const out = [];
  for (const m of String(text ?? "").matchAll(ADDRESS_RE)) {
    const address = `${m[1]}#${m[2]}`;
    if (out.includes(address)) continue;
    if (resolveAddress(address, root).ok) out.push(address);
  }
  return out;
}

// The whole answer, as data. `linked` is the set of addresses the task already
// carries — a candidate that is already linked is a CONFIRMATION, and calling
// it a find is how a tool trains you to stop reading it.
export function matchSections(text, { root = resolveRoot(), limit = DEFAULT_LIMIT, min = MIN_SCORE, linked = [] } = {}) {
  const corpus = buildCorpus(root);
  const query = terms(text);
  const named = addressesIn(text, root);
  const answer = {
    query: [...query.values()],
    min,
    domains: [...new Set(corpus.map((s) => s.domain))],
    linked,
    named,
    matches: [],
    near: null,
    zero: true,
    // "Ни один раздел не подошёл" и "по этому тексту вообще нельзя судить" —
    // разные ответы, и второй НЕ повод заводить раздел. Слить их в один `zero`
    // значило бы предлагать новый раздел под запрос из одного слова.
    undecided: true,
    reason: "",
  };
  if (!corpus.length) {
    answer.reason = "в реестре нет ни одного домена — искать не в чем";
    return answer;
  }
  if (query.size < 2) {
    answer.reason =
      "в тексте меньше двух значимых слов — по такому запросу нельзя честно сказать ни «есть», ни «нет»";
    return answer;
  }
  const idf = idfOver(corpus);
  // The same for every section (it is a property of the query), so it is
  // computed once and reported once, not repeated on every candidate.
  let informative = 0;
  const scored = corpus
    .map((s) => {
      const r = scoreSection(query, s, idf);
      informative = r.total;
      return {
        address: s.address,
        domain: s.domain,
        title: s.title,
        part: s.part,
        score: Number(r.score.toFixed(3)),
        heading_hits: r.heading,
        prose_hits: r.prose,
        named: named.includes(s.address),
        linked: linked.includes(s.address),
      };
    })
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));

  if (informative === 0) {
    answer.reason =
      "все значимые слова запроса встречаются во всех разделах сразу — по ним разделы не различаются";
    return answer;
  }
  const kept = scored.filter((s) => s.score >= min || s.named).slice(0, limit);
  answer.undecided = false;
  if (!kept.length) {
    const best = scored[0];
    answer.reason = "раздела под это нет: ни один не набрал порога";
    // The near miss is named, and named as a MISS: knowing the registry has
    // nothing closer than 0.1 is part of the answer, and hiding it would send
    // the reader to `spec domains` to reconstruct it by hand.
    answer.near = best && best.score > 0 ? best : null;
    return answer;
  }
  answer.zero = false;
  answer.matches = kept;
  return answer;
}

// --- the command -------------------------------------------------------------

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// What the board already knows about this task: the addresses it (or its change
// root) carries, and the text worth matching when the caller gave none. Read
// through todos.mjs dynamically, the way the rest of the registry reads the
// board — a match must not take a static dependency on it.
async function fromBoard(token) {
  const { loadBoard, resolveTask, changeRootsFor, specAddressesFor } = await import("./todos.mjs");
  const data = loadBoard();
  const todo = resolveTask(data, token);
  if (!todo) fail(`refusing: no task matches "${token}"`);
  const roots = changeRootsFor(data, todo);
  // Subject + the task's OWN description, and deliberately not the change
  // root's: the score is a share of the query's informative mass, so every
  // extra paragraph that is about something else drives every section down.
  // Measured on the 9 linked tasks on this board — subject alone puts the
  // linked section first in 8 of 9, subject + own description in 9 of 9, and
  // adding the root's delta on top pushes the right answer under the bar.
  return {
    todo,
    linked: specAddressesFor(todo, roots).addresses,
    text: [todo.subject, todo.description].filter(Boolean).join("\n"),
  };
}

const USAGE =
  'usage: cli spec match "<текст>" [--task <задача>] [--limit N] [--min 0.3] [--json]\n' +
  "       Ищет разделы спек, которых текст касается: тема, subject задачи, шаг плана.\n" +
  "       Отвечает и «раздела под это нет» — это полноценный ответ, а не пустой.\n" +
  "       Счёт — доля значимых слов запроса, покрытая разделом, поэтому подавать надо\n" +
  "       короткий текст: страница прозы размазывает счёт по десятку разделов и\n" +
  "       уводит верный ответ под порог.\n" +
  "       --task берёт subject + description задачи с доски и отмечает уже\n" +
  "       слинкованные разделы как сверку, а не как находку.";

// --- the seeding meter ------------------------------------------------------
//
// Seeding a registry onto an existing codebase is not measured by how many
// sections exist — it is measured by how often a task still finds NOTHING.
// The matcher answers that question once per call and then forgets it, so the
// one number that says whether coverage is growing (`how many asks in a row
// came back empty`) was impossible to get. Every call appends one line here.
//
// Append-only JSONL next to todos.json, one short line per ask, and the query
// is stored TRUNCATED: this is a meter, not a search history. Never throws —
// a lost measurement must not cost anyone an answer.
const QUERY_KEPT = 120;

export function meterFile() {
  return path.join(roamingBase(), "com.claude-usage-tracker.app", "spec-match.jsonl");
}

export function noteAsk(fields) {
  try {
    const file = meterFile();
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...fields }) + "\n");
  } catch {
    // measuring must never break the thing it measures
  }
}

export function readAsks(file = meterFile()) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function coverageOf(asks, project) {
  const rows = project ? asks.filter((a) => a.project === project) : asks;
  const empty = rows.filter((a) => a.zero);
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].zero; i--) streak++;
  const byQuery = new Map();
  for (const a of empty) {
    const key = String(a.query ?? "").toLowerCase();
    byQuery.set(key, (byQuery.get(key) ?? 0) + 1);
  }
  return {
    asks: rows.length,
    empty: empty.length,
    hit: rows.length - empty.length,
    share: rows.length ? Number((empty.length / rows.length).toFixed(2)) : 0,
    streak,
    recent: empty.slice(-10).map((a) => ({ at: String(a.ts).slice(0, 10), query: a.query, task: a.task ?? null })),
    repeated: [...byQuery.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]),
  };
}

// Long queries make long hit lists, and a wall of matched words is not evidence
// a reader can use — the first few are.
const HITS_SHOWN = 8;
const hits = (words) =>
  words.slice(0, HITS_SHOWN).join(", ") + (words.length > HITS_SHOWN ? `, … (+${words.length - HITS_SHOWN})` : "");

export async function run(args) {
  const positional = [];
  const flags = { limit: DEFAULT_LIMIT, min: MIN_SCORE };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") flags.json = true;
    else if (a === "--text") flags.text = args[++i];
    else if (a === "--task") flags.task = args[++i];
    else if (a === "--limit") flags.limit = Number(args[++i]);
    else if (a === "--min") flags.min = Number(args[++i]);
    else if (a === "-h" || a === "--help" || a === "help") {
      process.stdout.write(USAGE + "\n");
      return;
    } else if (a.startsWith("--")) fail(`unknown flag: ${a}\n${USAGE}`);
    else positional.push(a);
  }
  let text = flags.text ?? positional.join(" ");
  let linked = [];
  let todo = null;
  if (flags.task) {
    const board = await fromBoard(flags.task);
    linked = board.linked;
    todo = board.todo;
    if (!text.trim()) text = board.text;
  }
  if (!String(text).trim()) fail(USAGE);
  if (!Number.isFinite(flags.limit) || flags.limit < 1) fail("refusing: --limit must be a positive number");
  if (!Number.isFinite(flags.min) || flags.min < 0) fail("refusing: --min must be a non-negative number");

  const res = matchSections(text, { limit: flags.limit, min: flags.min, linked });
  noteAsk({
    project: path.basename(process.cwd()),
    query: String(text).replace(/\s+/g, " ").trim().slice(0, QUERY_KEPT),
    task: todo ? todo.number : null,
    zero: !!res.zero,
    top: res.matches?.[0]?.address ?? res.near?.address ?? null,
    score: res.matches?.[0]?.score ?? res.near?.score ?? null,
    linked: linked.length,
  });
  if (flags.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, task: todo ? todo.number : null, ...res }, null, 2) + "\n",
    );
    return;
  }
  const out = [];
  if (todo) out.push(`задача #${todo.number} "${todo.subject}"`);
  if (linked.length) out.push(`уже слинковано: ${linked.join(", ")}`);
  if (res.zero) {
    out.push(res.reason);
    if (res.near)
      out.push(
        `  ближайший — ${res.near.address} (${res.near.score}, порог ${res.min}); ` +
          `совпало: ${hits([...res.near.heading_hits, ...res.near.prose_hits]) || "ничего"}`,
      );
    // Naming a domain-candidate off a near miss that scored almost nothing is
    // how a guess turns into a wrong home for a new section. Below half the
    // threshold the honest suggestion is "any of them, or a new one".
    if (!res.undecided) {
      const candidate =
        res.near && res.near.score >= res.min / 2
          ? `домен-кандидат ${res.near.domain}`
          : `домен придётся выбрать самому: ${res.domains.join(" | ")} — или новый`;
      out.push(`  Это повод завести раздел (${candidate}) или сказать вслух, почему спека тут не нужна.`);
    }
    process.stdout.write(out.join("\n") + "\n");
    return;
  }
  for (const m of res.matches) {
    const marks = [
      m.named ? "адрес назван в тексте" : "",
      m.linked ? "УЖЕ СЛИНКОВАН — сверка, не находка" : "",
    ].filter(Boolean);
    out.push(
      `${m.address}  ${m.score}  [${m.part || "?"}]  ${m.title}${marks.length ? "  ← " + marks.join(" · ") : ""}`,
    );
    if (m.heading_hits.length) out.push(`    заголовок: ${hits(m.heading_hits)}`);
    if (m.prose_hits.length) out.push(`    текст: ${hits(m.prose_hits)}`);
  }
  const fresh = res.matches.filter((m) => !m.linked);
  if (fresh.length)
    out.push(
      "",
      `Прочитай раздел до работы: cli spec show ${fresh[0].address}`,
      `Слинкуй, если задача его правда задевает: cli todos set spec <задача> ${fresh[0].address}`,
    );
  process.stdout.write(out.join("\n") + "\n");
}
