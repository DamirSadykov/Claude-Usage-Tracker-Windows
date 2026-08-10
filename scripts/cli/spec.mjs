// `cli spec <cmd>` — the spec registry (t#339): frontmatter parser, address
// resolver and registry-wide validation for `docs/specs/<domain>/spec.md`, per
// the contract in docs/specs/README.md (t#349 metadata-format revision). The
// genre it serves is SDD (t#338): spec = long-lived state of a subsystem,
// addressed by section so a session never has to pull a whole file or domain
// into context (README §7).
//
// A domain is a directory under the spec root holding exactly one `spec.md`,
// whose frontmatter's `id` names the domain. A section is declared exactly
// once: its `## <slug> — <title>` heading plus a block of `key: value` lines
// directly under it (README §4) — there is no second, frontmatter-level map
// of sections to keep in sync with the body.
//
// Every read here is local and synchronous: the frontmatter that answers
// "does this address exist" always lives in THIS repo (README §3), even for a
// section whose actual text lives elsewhere — only the TEXT of such a section
// may be unavailable, never its existence.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseYamlSubset } from "./yaml-subset.mjs";
import { specRoot as specRootSetting, specRepoPath } from "./settings.mjs";

const PARTS = ["требования", "устройство", "инварианты"];
export const SECTION_LINE_CEILING = 120;

// A tracker task reference (`t#347`) — the notation the board trains everyone
// to write in prose. Forbidden inside a section's TEXT: a spec is the state
// that outlives the tasks, and a task is a transient thing that is renumbered,
// deleted, or simply closed and forgotten. A section that says "built at t#339"
// answers "who did this", which git blame answers better, while quietly making
// the spec unreadable without the board next to it.
//
// The metadata block is the sanctioned place for exactly one such reference —
// `change:` — and it is written by the machine (stampSection), not by hand.
const TASK_LINK_RE = /\bt#\d+\b/gi;

// Task references in a section's prose lines, as {line, ref} pairs (`line` is
// 1-based within the prose). Exported for the tests and for the answer command.
export function taskLinksIn(prose) {
  const out = [];
  (Array.isArray(prose) ? prose : []).forEach((text, i) => {
    TASK_LINK_RE.lastIndex = 0;
    let m;
    while ((m = TASK_LINK_RE.exec(text))) out.push({ line: i + 1, ref: m[0], text: text.trim() });
  });
  return out;
}

export function resolveRoot(cwd = process.cwd(), appData) {
  const configured = specRootSetting(appData);
  return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
}

function splitFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(raw ?? ""));
  if (!m) return null;
  const fm = parseYamlSubset(m[1]);
  return { fm, body: m[2] };
}

const HEADING_RE = /^##\s+(\S+)\s+[—-]\s+(.+?)\s*$/;
const META_LINE_RE = /^([a-zA-Z][a-zA-Z_-]*):\s*(.*)$/;

// A metadata line is one or more `key: value` pairs joined by ` · ` (README
// §4). Every segment has to parse as a pair for the line to count as
// metadata at all — a line that fails is prose, not a partially-read pair.
function splitMetaLine(line) {
  const pairs = [];
  for (const seg of line.split(/\s*·\s*/)) {
    const m = META_LINE_RE.exec(seg.trim());
    if (!m) return null;
    pairs.push([m[1].toLowerCase(), m[2].trim()]);
  }
  return pairs;
}

function parseRefsValue(v) {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseLocationValue(v) {
  const out = {};
  for (const tok of v.trim().split(/\s+/)) {
    const m = /^(repo|path)=(.*)$/.exec(tok);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// The lines right under a heading: an optional blank line, then zero or more
// metadata lines, then prose. The block ends at the first line that is blank
// or does not parse as `key: value` — once ended it never resumes, so a
// prose line that happens to look like `key: value` further down stays prose
// (README §4's "первая строка, не похожая на ключ: значение, заканчивает
// блок").
function parseSectionBody(lines) {
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const meta = {};
  while (i < lines.length && lines[i].trim()) {
    const pairs = splitMetaLine(lines[i]);
    if (!pairs) break;
    for (const [k, v] of pairs) meta[k] = v;
    i++;
  }
  const prose = lines.slice(i);
  while (prose.length && !prose[0].trim()) prose.shift();
  while (prose.length && !prose.at(-1).trim()) prose.pop();
  return { meta, prose };
}

// The text `showSection` hands back for a local section: heading, then
// `part`/`refs` (useful to a session deciding what a section is and what it
// looks at), then the prose. `updated`/`change` are provenance for the
// registry and git blame, not something a reader needs to see every time the
// section is injected (README §7) — they are deliberately left out here.
function buildSectionText(headingLine, meta, prose) {
  const out = [headingLine];
  const metaLines = [];
  if (meta.part) metaLines.push(`part: ${meta.part}`);
  if (meta.refs) metaLines.push(`refs: ${meta.refs}`);
  if (metaLines.length) out.push("", ...metaLines);
  if (prose.length) out.push("", ...prose);
  return out.join("\n");
}

// An ADDRESSABLE UNIT inside a section: `### <слаг> — <Название>` (t#358).
// Same shape as a section heading one level down, so there is one form to
// learn and one regex family to keep honest.
//
// Why at all: a link that can only name a section makes every question about
// it a question about the whole thing — the matcher weighs a query against 145
// lines of mixed subjects, a task points at "the registry" rather than at the
// rule it changes, and attribution has to be recovered from bullet hashes
// because there is no named unit to hang it on. OpenSpec's answer is a
// `### Requirement:` block, and taking the ADDRESSABLE UNIT is the part of it
// that transfers: their `SHALL` / `WHEN` / `THEN` dialect states testable
// behaviour, while half of these sections carry the reasoning behind a design
// — forcing that into scenarios loses the reasoning or invents the scenarios.
//
// Anchors are OPTIONAL by decision: a section of running prose stays running
// prose. A mandatory unit would let the form dictate the content.
const ANCHOR_RE = /^###\s+(\S+)\s+[—-]\s+(.+?)\s*$/;

export function parseAnchors(prose) {
  const lines = Array.isArray(prose) ? prose : [];
  const marks = [];
  lines.forEach((line, i) => {
    const m = ANCHOR_RE.exec(line);
    if (m) marks.push({ slug: m[1], title: m[2], line: i });
  });
  const out = marks.map((mk, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1].line : lines.length;
    const body = lines.slice(mk.line + 1, end);
    while (body.length && !body[0].trim()) body.shift();
    while (body.length && !body.at(-1).trim()) body.pop();
    return {
      slug: mk.slug,
      title: mk.title,
      line: mk.line,
      prose: body,
      text: [lines[mk.line], ...(body.length ? ["", ...body] : [])].join("\n"),
    };
  });
  // Same failure as a duplicated section slug: the second declaration wins the
  // lookup and the first quietly stops existing.
  out.duplicates = marks
    .map((m) => m.slug)
    .filter((slug, i, all) => all.indexOf(slug) !== i)
    .filter((slug, i, dups) => dups.indexOf(slug) === i);
  // Prose before the first anchor — a section can introduce itself and then
  // break into units, and that lead-in belongs to no anchor.
  const lead = marks.length ? lines.slice(0, marks[0].line) : lines.slice();
  while (lead.length && !lead.at(-1).trim()) lead.pop();
  out.lead = lead;
  return out;
}

function parseHeadings(body) {
  const lines = String(body ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const marks = [];
  lines.forEach((line, i) => {
    const m = HEADING_RE.exec(line);
    if (m) marks.push({ slug: m[1], title: m[2], line: i });
  });
  const out = new Map();
  // A slug declared twice: the Map keeps the LAST one, so the first section
  // silently stops existing — its `part`, its prose and its provenance are
  // simply unreachable. Collected here so lint can refuse it; without that the
  // registry answers confidently about a section nobody can see.
  out.duplicates = marks
    .map((m) => m.slug)
    .filter((slug, i, all) => all.indexOf(slug) !== i)
    .filter((slug, i, dups) => dups.indexOf(slug) === i);
  marks.forEach((mk, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1].line : lines.length;
    const { meta, prose } = parseSectionBody(lines.slice(mk.line + 1, end));
    out.set(mk.slug, {
      title: mk.title,
      line: mk.line,
      meta,
      prose,
      anchors: parseAnchors(prose),
      lineCount: prose.length,
      text: buildSectionText(lines[mk.line], meta, prose),
    });
  });
  return out;
}

export function listDomainIds(root = resolveRoot()) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, "spec.md")))
    .map((e) => e.name)
    .sort();
}

// Markdown sitting in the registry root that is NOT a domain — the old flat
// form. An empty listing must name them, or "no domains" reads as "nothing is
// written" when in fact the texts are there in a shape the registry cannot see.
export function strayFiles(root = resolveRoot()) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "README.md")
    .map((e) => e.name)
    .sort();
}

const asLocationObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

// One domain, parsed. `error` is set instead of throwing — a domain that fails
// to read or parse is reported by lint/show, not a crash of the registry.
//
// `sections` is built from the body's headings and each one's metadata block
// (README §4), never from a frontmatter map — a section that exists is a
// heading that exists, nothing to keep in sync.
//
// `external` is the domain-level `location: {repo, path}` (README §4): the
// file at `docs/specs/<id>/spec.md` is then a STUB — its headings and their
// metadata are the real, local, addressable thing, but each heading carries
// no prose, because the actual text (on the far side, under the same slugs)
// lives in another repo. A stub's sections having zero prose lines is
// expected, not a parse failure.
export function loadDomain(id, root = resolveRoot()) {
  const file = path.join(root, id, "spec.md");
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return { id, file, error: `не читается: ${e.message}` };
  }
  const split = splitFrontmatter(raw);
  if (!split) return { id, file, error: "нет YAML frontmatter (--- … ---) в начале файла" };
  const { fm, body } = split;
  const headings = parseHeadings(body);
  const sections = {};
  for (const [slug, h] of headings) {
    sections[slug] = {
      title: h.title,
      part: h.meta.part,
      refs: h.meta.refs ? parseRefsValue(h.meta.refs) : undefined,
      location: h.meta.location ? parseLocationValue(h.meta.location) : undefined,
      updated: h.meta.updated,
      change: h.meta.change,
      anchors: (h.anchors ?? []).map((a) => ({ slug: a.slug, title: a.title })),
    };
  }
  return { id, file, fm, body, sections, headings, external: asLocationObject(fm.location) };
}

// --- blocks: the finest thing a change can be pinned to ----------------------
//
// A section runs to ~120 lines and half a dozen changes may have touched it
// over its life. Saying "these changes are about this section" answers nothing
// useful when you are standing on one bullet asking who wrote it.
//
// So a section is also read as a list of BLOCKS — a top-level bullet or
// paragraph with its indented continuation. A block is identified by the hash
// of its own text, never by its position: bullets get inserted above and below
// all the time, and a line number would point at a neighbour by tomorrow.
// Identity-by-content also expires the mark on its own — edit a bullet and its
// hash changes, so the attribution moves to whoever changed it last, which is
// exactly the answer wanted.
export function sectionBlocks(prose) {
  const lines = Array.isArray(prose) ? prose : String(prose ?? "").split("\n");
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const isStart = line.trim() && !/^\s/.test(line);
    if (isStart) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks.map((body) => {
    while (body.length && !body.at(-1).trim()) body.pop();
    const text = body.join("\n");
    return { text, hash: hashOf(text) };
  });
}

const hashOf = (s) =>
  createHash("sha256").update(String(s).replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);

// The blocks of an addressed section, or [] when the address does not resolve
// or its text lives elsewhere (nothing local to attribute).
export function blocksOf(address, root = resolveRoot()) {
  const r = resolveAddress(address, root);
  if (!r.ok) return [];
  return sectionBlocks(proseFor(r));
}

// Fingerprint of a section's PROSE — the thing a delta is supposed to move.
// Metadata is deliberately out: the stamp itself changes those lines, so
// hashing them would make every section look edited the moment it was stamped.
// Whitespace is normalised so a reflow of the same sentences is not a delta.
export function sectionFingerprint(address, root = resolveRoot()) {
  const r = resolveAddress(address, root);
  if (!r.ok) return "";
  const prose = proseFor(r).join("\n").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(prose).digest("hex").slice(0, 16);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

// `<домен>#<слаг>` or, since t#358, `<домен>#<слаг>/<якорь>`. The slash was
// picked because neither half's charset contains it, so the split is
// unambiguous without escaping and an old two-part address stays exactly what
// it always was.
export function parseAddress(address) {
  const s = String(address ?? "").trim();
  const i = s.indexOf("#");
  if (i <= 0 || i === s.length - 1) return null;
  const domain = s.slice(0, i);
  const rest = s.slice(i + 1);
  const j = rest.indexOf("/");
  const slug = j < 0 ? rest : rest.slice(0, j);
  const anchor = j < 0 ? null : rest.slice(j + 1);
  if (!SLUG_RE.test(domain) || !SLUG_RE.test(slug)) return null;
  if (anchor !== null && !SLUG_RE.test(anchor)) return null;
  return { domain, slug, anchor };
}

// Resolve `<domain>#<slug>` against the registry: existence only, never the
// availability of a remote section's text (README §4/§6 — those are separate
// questions). `ok: false` is the one shape `todos set spec` refuses on.
export function resolveAddress(address, root = resolveRoot()) {
  const parsed = parseAddress(address);
  if (!parsed)
    return {
      ok: false,
      address,
      reason: `не адрес: "${address}" — ожидается <домен>#<слаг> или <домен>#<слаг>/<якорь>`,
    };
  const { domain, slug, anchor } = parsed;
  const domains = listDomainIds(root);
  if (!domains.includes(domain))
    return {
      ok: false,
      address,
      reason: `нет такого домена "${domain}" (известны: ${domains.join(", ") || "нет ни одного"})`,
    };
  const dom = loadDomain(domain, root);
  if (dom.error) return { ok: false, address, reason: `домен "${domain}": ${dom.error}` };
  if (!(slug in dom.sections))
    return {
      ok: false,
      address,
      reason: `нет раздела "${slug}" в домене "${domain}" (известны: ${Object.keys(dom.sections).join(", ") || "нет ни одного"})`,
    };
  if (!anchor) return { ok: true, address, domain: dom, slug, anchor: null, entry: dom.sections[slug] };
  const anchors = dom.headings.get(slug)?.anchors ?? [];
  const found = anchors.find((a) => a.slug === anchor);
  if (!found)
    return {
      ok: false,
      address,
      reason:
        `нет якоря "${anchor}" в разделе "${domain}#${slug}" ` +
        `(известны: ${anchors.map((a) => a.slug).join(", ") || "раздел не разбит на якоря"})`,
    };
  return { ok: true, address, domain: dom, slug, anchor, entry: dom.sections[slug], unit: found };
}

// The prose an address actually names: the anchor's when it has one, the whole
// section's otherwise. Every consumer that used to reach for `heading.prose`
// goes through here, or an anchored address would silently answer about its
// whole section — the one failure that would make the finer link worthless.
export function proseFor(r) {
  const heading = r.ok ? r.domain.headings.get(r.slug) : null;
  if (!heading) return [];
  return r.anchor ? (r.unit ? r.unit.prose : []) : heading.prose;
}

const remoteLocation = (entry) => asLocationObject(entry && entry.location);

// Where an addressed section's TEXT actually lives: its own `location`
// (README §4, section-level override) wins if present; otherwise it inherits
// its domain's `location`, when the whole domain is external (§4). `via`
// tells `showSection` how to read what comes back: a section-level location
// is a raw text blob at `path` (the registry never parses it); a domain-level
// one is another `spec.md` on the far side, addressed by the SAME slug.
function effectiveLocation(dom, entry) {
  const own = remoteLocation(entry);
  if (own) return { ...own, via: "section" };
  if (dom.external) return { ...dom.external, via: "domain" };
  return null;
}

function unavailable({ address, repo, message, stub, entry }) {
  return { ok: true, address, remote: true, available: false, repo: repo || "", unavailable: message, stub, entry };
}

// A remote section's text on the far side is opaque to the registry — read
// verbatim, never parsed. A remote DOMAIN's is another `spec.md`: parse it
// the same way a local one is parsed and pull out the same slug, falling
// back to the raw text if the far side does not turn out to be in that shape
// (better a readable dump than a crash on a file this repo does not own).
function readExternalSectionText(repoPath, remotePath, slug) {
  const full = path.join(repoPath, remotePath);
  const raw = readFileSync(full, "utf8");
  const split = splitFrontmatter(raw);
  if (split) {
    const heading = parseHeadings(split.body).get(slug);
    if (heading) return { full, text: heading.text };
  }
  return { full, text: raw };
}

// The text of one addressed section, or the "domain declared, text
// unavailable" answer for a section (or a whole external domain) whose
// `location` points outside this repo and whose repo is not reachable from
// here (README §4's required third answer, alongside "found" and "no such
// address").
export function showSection(address, root = resolveRoot(), appData) {
  const r = resolveAddress(address, root);
  if (!r.ok) return r;
  const remote = effectiveLocation(r.domain, r.entry);
  const heading = r.domain.headings.get(r.slug);
  if (!remote) {
    // An anchored address answers about ITS unit and says so in `entry.title`;
    // the section's own title travels alongside, since a unit read out of its
    // section reads as an orphan.
    const unit = r.anchor ? r.unit : null;
    return {
      ok: true,
      address,
      remote: false,
      entry: unit ? { ...r.entry, title: unit.title, section: r.entry.title } : r.entry,
      anchor: r.anchor || null,
      // What the section is broken into, so a reader can walk to a sibling unit
      // without re-parsing the file.
      anchors: heading ? (heading.anchors ?? []).map((a) => ({ slug: a.slug, title: a.title })) : [],
      text: unit ? unit.text : heading ? heading.text : "",
      // Blocks travel with the text so a reader can attribute each one without
      // re-parsing what the registry has already parsed.
      blocks: heading ? sectionBlocks(proseFor(r)) : [],
    };
  }
  const stub = heading ? heading.text : "";
  const whose = remote.via === "domain" ? `домен "${r.domain.id}"` : `раздел "${address}"`;
  if (!remote.repo || !remote.path) {
    return unavailable({
      address,
      repo: remote.repo,
      message: `домен объявлен, текст недоступен: ${whose} ссылается на внешнее расположение без repo/path`,
      stub,
      entry: r.entry,
    });
  }
  const repoPath = specRepoPath(remote.repo, appData);
  if (!repoPath) {
    return unavailable({
      address,
      repo: remote.repo,
      message:
        `домен объявлен, текст недоступен: репозиторий "${remote.repo}" не настроен ` +
        `(добавь его в settings.json → specRepos.${remote.repo})`,
      stub,
      entry: r.entry,
    });
  }
  try {
    const read =
      remote.via === "domain"
        ? readExternalSectionText(repoPath, remote.path, r.slug)
        : { full: path.join(repoPath, remote.path), text: readFileSync(path.join(repoPath, remote.path), "utf8") };
    return { ok: true, address, remote: true, available: true, repo: remote.repo, path: read.full, text: read.text, entry: r.entry };
  } catch (e) {
    return unavailable({
      address,
      repo: remote.repo,
      message:
        `домен объявлен, текст недоступен: репозиторий "${remote.repo}" настроен на ${repoPath}, ` +
        `но ${remote.path} не читается (${e.message})`,
      stub,
      entry: r.entry,
    });
  }
}

// --- the registry's ONE write path (t#341) ---------------------------------
//
// Until the closing guard the registry was read-only by design. §8 of the
// README gives it exactly one write: when a session answers `spec updated`,
// the section's provenance (`updated` + `change`) is stamped for it, so §7's
// "раздел свежий, спросить вот у этой задачи" holds without a second journal.
//
// It writes through the SAME metadata parse the readers use, never a regex
// over the file: a section whose block is shaped unusually would otherwise be
// corrupted silently, and a corrupted spec is exactly the drift the guard
// exists to prevent. Untouched lines are spliced back verbatim, so the diff a
// human reads is the one line that changed.

const ymd = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Re-render one metadata line without the pairs the stamp owns. Returns null
// when nothing is left — the line then disappears instead of staying empty.
function withoutProvenance(pairs) {
  const kept = pairs.filter(([k]) => k !== "updated" && k !== "change");
  if (!kept.length) return null;
  return kept.map(([k, v]) => `${k}: ${v}`).join(" · ");
}

// Stamp `updated: <date> · change: <ref>` onto an addressed section. `ref` is
// the task or change that made the delta, written as the tracker writes it
// (`t#347`). Returns {ok, file, line} or {ok:false, reason} — never throws on
// a bad address, since the caller is a guard that must stay a nudge.
export function stampSection(address, { ref, date = ymd(), root = resolveRoot() } = {}) {
  const r = resolveAddress(address, root);
  if (!r.ok) return r;
  const file = r.domain.file;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, address, reason: `не читается ${file}: ${e.message}` };
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m && m[1] === r.slug) heads.push(i);
  }
  if (!heads.length)
    return { ok: false, address, reason: `заголовок раздела "${r.slug}" не найден в ${file}` };
  // Two headings with one slug: the reader returns the LAST, so stamping the
  // first would put the provenance on a section nobody answered about. Refuse
  // instead of guessing — lint reports the same thing as an error.
  if (heads.length > 1)
    return {
      ok: false,
      address,
      reason: `слаг "${r.slug}" объявлен ${heads.length} раза в ${file} — непонятно, какой раздел штамповать; оставь один`,
    };
  const head = heads[0];

  let i = head + 1;
  while (i < lines.length && !lines[i].trim()) i++;
  const blockStart = i;
  const rebuilt = [];
  while (i < lines.length && lines[i].trim()) {
    const pairs = splitMetaLine(lines[i]);
    if (!pairs) break;
    const kept = withoutProvenance(pairs);
    if (kept !== null) rebuilt.push(kept);
    i++;
  }
  const blockEnd = i;
  rebuilt.push(`updated: ${date} · change: ${ref}`);

  const next = [...lines.slice(0, blockStart), ...rebuilt, ...lines.slice(blockEnd)];
  try {
    writeFileSync(file, next.join(eol));
  } catch (e) {
    return { ok: false, address, reason: `не пишется ${file}: ${e.message}` };
  }
  return { ok: true, address, file, line: blockStart, stamp: `updated: ${date} · change: ${ref}` };
}

// Sections (anywhere in the registry) whose `refs` name this address —
// computed by scanning, never stored as a second field (README §6: direction
// is declared once, on the referencing side).
export function reverseRefs(address, root = resolveRoot()) {
  const target = parseAddress(address);
  if (!target) return [];
  const incoming = [];
  for (const id of listDomainIds(root)) {
    const dom = loadDomain(id, root);
    if (dom.error) continue;
    for (const [slug, entry] of Object.entries(dom.sections)) {
      for (const ref of refsOf(entry)) {
        const parsed = parseAddress(ref);
        if (parsed && parsed.domain === target.domain && parsed.slug === target.slug) {
          incoming.push(`${id}#${slug}`);
        }
      }
    }
  }
  return incoming;
}

function refsOf(entry) {
  const raw = entry && entry.refs;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

// --- do the files a section names still exist? -------------------------------
//
// README §2 forbids describing the SHAPE of the code, on the grounds that file
// and function names go stale. The rule was never checked, and the spec of this
// very subsystem names paths and symbols on 56 lines. Two honest ways out:
// delete them all, or make each one a checked claim. The second is better —
// the names are what make a section actionable, and a name that resolves is not
// the failure §2 warns about; a name that does not is exactly it.
//
// What counts as a claim: an inline code span whose head looks like a file —
// either a path with a separator, or a bare filename with a known extension.
// Anything holding a template placeholder, a glob or a space is prose about a
// shape, not a claim about a file, and is skipped.

const CODE_SPAN_RE = /`([^`]+)`/g;
// A bare filename is only judged when it names SOURCE. Data and config files
// are named in specs all the time and mostly do not live in the repository at
// all — `todos.json` and `settings.json` sit in the app data directory, and a
// rule that called those stale would be wrong on its first run, which is how a
// lint rule gets switched off for good.
const SOURCE_EXT_RE = /\.(mjs|cjs|js|ts|tsx|vue|rs|py|sh|ps1)$/i;
const FILE_EXT_RE =
  /\.(mjs|cjs|js|ts|tsx|vue|rs|json|md|py|toml|ya?ml|sh|ps1|yml|html|css|sql)$/i;

// Everything a walk of the project can see, as a set of relative paths plus a
// map of basename → count. Heavy build/vendor trees are skipped: nothing in a
// spec should be claiming a path inside them, and walking them would dominate
// the cost of linting two files.
const SKIP_DIRS = new Set([
  "node_modules", "target", "dist", ".git", ".vs", "build", "coverage", "vendor",
]);

// Dot-directories are NOT skipped wholesale. The heavy ones are named above,
// and the rest are exactly where a spec has business pointing: `.github`
// holds the CI this registry is linted by, `.claude` holds the skills and
// hooks that drive the board. Skipping them made the lint call a file that is
// right there a lie — the rule's one failure mode, since it can only ever
// report absence.

function indexProject(projectRoot, budget = 20000) {
  const paths = new Set();
  const names = new Set();
  const stack = [""];
  let seen = 0;
  while (stack.length && seen < budget) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(path.join(projectRoot, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(child);
        continue;
      }
      if (++seen > budget) break;
      paths.add(child);
      names.add(e.name);
    }
  }
  return { paths, names, truncated: seen >= budget };
}

// The file a code span claims, or null when the span is not a claim about one.
export function fileClaimOf(span) {
  // `todos.mjs::specAddressesFor` and `GraphView.vue::changeSections` — the
  // symbol after `::` is not ours to resolve, the file before it is.
  const head = String(span).split("::")[0].trim().replace(/^\.\//, "");
  if (!head || /[<>*?{}\s|]/.test(head)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(head)) return null; // a URL
  // Outside the project by construction: a home-relative or absolute path.
  // `~/.claude/settings.json` is a real file and none of this repo's business.
  if (/^[~/]/.test(head) || /^[a-z]:[\\/]/i.test(head)) return null;
  if (!FILE_EXT_RE.test(head)) return null;
  if (!head.includes("/") && !SOURCE_EXT_RE.test(head)) return null;
  return head;
}

function fileClaimFindings(dom, slug, heading, index, projectRoot) {
  const address = `${dom.id}#${slug}`;
  const out = [];
  const claimed = new Set();
  for (const line of heading.prose) {
    CODE_SPAN_RE.lastIndex = 0;
    let m;
    while ((m = CODE_SPAN_RE.exec(line))) {
      const claim = fileClaimOf(m[1]);
      if (claim) claimed.add(claim);
    }
  }
  for (const claim of claimed) {
    // A path is usually written the way a reader needs it, not from the repo
    // root — `insightHelp/render.ts` for `src/insightHelp/render.ts`. A suffix
    // match keeps that readable form legal while still catching a rename.
    const exists = claim.includes("/")
      ? index.paths.has(claim) || [...index.paths].some((p) => p.endsWith(`/${claim}`))
      : index.names.has(claim);
    if (exists) continue;
    out.push(
      finding(
        "missing-path",
        "error",
        address,
        `${address}: раздел называет \`${claim}\`, а такого файла в проекте (${projectRoot}) нет — ` +
          `имя переименовали или удалили, и раздел с тех пор врёт`,
      ),
    );
  }
  return out;
}

function finding(rule, severity, address, message) {
  return { rule, severity, address, message };
}

// The whole-registry checks (README §4/§6/§7): a section missing its
// required `part`, an invalid or dangling `refs` entry, a section over the
// ~120-line ceiling. Every scan walks every domain — nothing here is cached
// across calls, so a finding is never stale relative to what is on disk
// right now.
export function validateRegistry(root = resolveRoot(), projectRoot = process.cwd()) {
  const ids = listDomainIds(root);
  const domains = ids.map((id) => loadDomain(id, root));
  const domainIds = new Set(ids);
  const findings = [];
  // Built once for the whole scan: every section's file claims are checked
  // against the same index (see fileClaimFindings).
  const index = ids.length ? indexProject(projectRoot) : { paths: new Set(), names: new Set() };

  for (const dom of domains) {
    if (dom.error) {
      findings.push(finding("domain-unreadable", "error", dom.id, `домен "${dom.id}": ${dom.error}`));
      continue;
    }
    if (!dom.fm.id) {
      findings.push(finding("missing-id", "error", dom.id, `домен "${dom.id}": во frontmatter нет id`));
    } else if (dom.fm.id !== dom.id) {
      findings.push(
        finding(
          "id-mismatch",
          "error",
          dom.id,
          `каталог "${dom.id}" ≠ frontmatter id "${dom.fm.id}" — адресация идёт по id`,
        ),
      );
    }

    for (const slug of dom.headings.duplicates ?? []) {
      findings.push(
        finding(
          "duplicate-slug",
          "error",
          `${dom.id}#${slug}`,
          `${dom.id}#${slug}: слаг объявлен больше одного раза — читатель отдаёт последний раздел, ` +
            `а всё, что стояло под первым заголовком, перестаёт существовать для реестра, не переставая ` +
            `лежать в файле`,
        ),
      );
    }

    if (dom.external && (!dom.external.repo || !dom.external.path)) {
      findings.push(
        finding("malformed-location", "error", dom.id, `домен "${dom.id}": location требует и repo, и path`),
      );
    }

    for (const [slug, entry] of Object.entries(dom.sections)) {
      const address = `${dom.id}#${slug}`;
      const part = entry && entry.part;
      if (!part) {
        findings.push(finding("missing-part", "error", address, `${address}: нет part в метаданных раздела`));
      } else if (!PARTS.includes(part)) {
        findings.push(
          finding("invalid-part", "error", address, `${address}: part "${part}" не из ${PARTS.join("|")}`),
        );
      }
      const remote = remoteLocation(entry);
      if (remote && (!remote.repo || !remote.path)) {
        findings.push(
          finding("malformed-location", "error", address, `${address}: location требует и repo, и path`),
        );
      }
      // A domain-level stub (§4) carries headings with no prose on purpose —
      // the line-count ceiling is about text this repo holds, and a stub
      // holds none.
      if (!dom.external && !remote) {
        const heading = dom.headings.get(slug);
        for (const link of taskLinksIn(heading.prose)) {
          findings.push(
            finding(
              "task-link",
              "error",
              address,
              `${address}: ссылка на задачу "${link.ref}" в тексте раздела — спека переживает задачи, ` +
                `а задача переживает от силы неделю. Что сделано — пишется без номера; кто и когда — ` +
                `git blame и строка метаданных change. (строка ${link.line}: ${link.text.length > 70 ? link.text.slice(0, 70) + "…" : link.text})`,
            ),
          );
        }
        findings.push(...fileClaimFindings(dom, slug, heading, index, projectRoot));
        for (const dup of heading.anchors?.duplicates ?? []) {
          findings.push(
            finding(
              "duplicate-anchor",
              "error",
              address,
              `${address}: якорь "${dup}" объявлен дважды — адрес ${address}/${dup} разрешается во второй, ` +
                `и первый перестаёт существовать, оставаясь при этом на экране`,
            ),
          );
        }
        // The ceiling stays a SECTION budget: the section is what a session is
        // given (README §7), and letting each anchor have its own would just
        // move the same wall further away while the read cost doubled.
        const lc = heading.lineCount;
        if (lc > SECTION_LINE_CEILING) {
          findings.push(
            finding(
              "section-too-long",
              "warning",
              address,
              `${address}: ${lc} строк(и), потолок ~${SECTION_LINE_CEILING} — раздел пора делить на два слага`,
            ),
          );
        }
      }
      for (const ref of refsOf(entry)) {
        const parsed = parseAddress(ref);
        if (!parsed) {
          findings.push(finding("malformed-ref", "error", address, `${address}: refs содержит не-адрес "${ref}"`));
          continue;
        }
        if (!domainIds.has(parsed.domain)) {
          findings.push(
            finding(
              "dangling-ref",
              "error",
              address,
              `${address}: refs "${ref}" — нет домена "${parsed.domain}"`,
            ),
          );
          continue;
        }
        const targetDom = domains.find((d) => d.id === parsed.domain);
        if (!targetDom || targetDom.error || !(parsed.slug in (targetDom.sections || {}))) {
          findings.push(
            finding(
              "dangling-ref",
              "error",
              address,
              `${address}: refs "${ref}" указывает на несуществующий слаг`,
            ),
          );
          continue;
        }
        // An anchor that no longer exists is the same dangling reference one
        // level down, and the level where renames actually happen: a section
        // slug is public and rarely moves, a unit inside it is rewritten by
        // whoever is working there.
        if (
          parsed.anchor &&
          !(targetDom.headings?.get(parsed.slug)?.anchors ?? []).some((a) => a.slug === parsed.anchor)
        ) {
          findings.push(
            finding(
              "dangling-ref",
              "error",
              address,
              `${address}: refs "${ref}" — в разделе нет якоря "${parsed.anchor}"`,
            ),
          );
        }
      }
    }
  }

  return findings;
}

export function splitFindings(findings) {
  return {
    errors: findings.filter((f) => f.severity === "error"),
    warnings: findings.filter((f) => f.severity === "warning"),
  };
}

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// --- the closing answer (t#341) ----------------------------------------------
//
// README §8: closing a task that carries `spec` demands an explicit answer per
// addressed section — it still holds (`unchanged`), or the work moved it
// (`updated`). The answer is a COMMAND, not a phrase in prose: the handoff
// guard taught this session that a wording-matched gate trains you to reword
// rather than to think (its NEXT_RE refused a baton whose next step was
// written as "ПЕРВЫЙ ХОД"). So the guard looks for a record, and the record
// can only be made by answering.
//
// Recorded on the task as `spec_answers: [{address, verdict, note, at}]` —
// one entry per address, replaced when re-answered. `updated` additionally
// stamps the section's provenance (stampSection), which is the only registry
// write there is.

export const MIN_ANSWER_CHARS = 40;
const VERDICTS = ["unchanged", "updated"];

// The change/task the stamp names. A step of a change points at the change —
// that is the unit §7 wants to be able to ask "why did this section move".
export function stampRefFor(roots, todo) {
  const root = (Array.isArray(roots) ? roots : []).find((r) => r && r.number != null);
  return `t#${root ? root.number : todo.number}`;
}

async function cmdAnswer(args) {
  const { resolveTask, loadBoard, boardPath, saveBoard, changeRootsFor, specAddressesFor } =
    await import("./todos.mjs");
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--text" || a === "--address") flags[a.slice(2)] = args[++i];
    else if (a === "--json") flags.json = true;
    else positional.push(a);
  }
  const [token, verdict] = positional;
  if (!token || !VERDICTS.includes(verdict)) fail(ANSWER_USAGE);

  const file = boardPath();
  const data = loadBoard(file);
  const todo = resolveTask(data, token);
  if (!todo) fail(`refusing: no task matches "${token}"`);

  const roots = changeRootsFor(data, todo);
  const link = specAddressesFor(todo, roots);
  if (!link.addresses.length)
    fail(
      `refusing: #${todo.number} "${todo.subject}" carries no spec link (neither its own nor its change root's) — ` +
        `nothing to answer for. Link it first: todos set spec ${todo.number} <домен>#<слаг>`,
    );

  let targets;
  if (flags.address) {
    if (!link.addresses.includes(flags.address))
      fail(
        `refusing: #${todo.number} does not address "${flags.address}" — it addresses ${link.addresses.join(", ")}`,
      );
    targets = [flags.address];
  } else if (link.addresses.length === 1) {
    targets = link.addresses;
  } else {
    // One note stretched over several sections IS the template answer §9 calls
    // the same rot on a new layer. Make the caller say which section it is
    // about, one at a time.
    fail(
      `refusing: #${todo.number} addresses ${link.addresses.length} sections (${link.addresses.join(", ")}) — ` +
        `answer them one at a time with --address, a section each, not one verdict for all`,
    );
  }

  const note = String(flags.text ?? "").trim();
  if (note.length < MIN_ANSWER_CHARS)
    fail(
      `refusing: --text is ${note.length} chars — an answer about a section is at least ${MIN_ANSWER_CHARS} ` +
        `(${verdict === "unchanged" ? "why the section still holds after this work" : "what in the section moved"})`,
    );

  const root = resolveRoot();
  const answers = Array.isArray(todo.spec_answers) ? todo.spec_answers.slice() : [];
  const clash = answers.find(
    (a) => a && a.address !== targets[0] && String(a.note || "").trim() === note,
  );
  if (clash)
    fail(
      `refusing: this is word-for-word the answer already given for ${clash.address} — ` +
        `two sections answered with one sentence is the template answer README §9 counts as rot`,
    );

  // BOTH verdicts resolve the address first. The link was validated when it was
  // written, but a slug can be renamed or dropped afterwards — and an answer
  // about a section that no longer exists clears the guard while saying nothing.
  // Leaving this to the `updated` branch alone (which resolves on its way to
  // stamping) made `unchanged` the one unguarded path: no edit, no check, no
  // stamp — exactly the shape a session under pressure drifts towards.
  for (const address of targets) {
    const r = resolveAddress(address, root);
    if (!r.ok)
      fail(
        `refusing: ${r.reason}\n  Раздел мог быть переименован или удалён уже после того, как ссылка ` +
          `записана.\n  Поправь ссылку задачи (todos set spec ${todo.number} <домен>#<слаг>) и отвечай по ` +
          `тому разделу, который есть.`,
      );
  }

  const stamps = [];
  const unverified = [];
  if (verdict === "updated") {
    const ref = stampRefFor(roots, todo);
    for (const address of targets) {
      // "The section moved" is a claim about the TEXT, and until now it cost
      // exactly as much as "it did not": the stamp went on without comparing
      // anything. The baseline is the fingerprint taken when the section was
      // injected at in_progress (todos.mjs::recordSpecBaseline).
      const seen = (Array.isArray(todo.spec_seen) ? todo.spec_seen : []).find(
        (x) => x && x.address === address,
      );
      if (!seen) {
        // No baseline — the task never passed through the injection anchor.
        // Say so instead of pretending the claim was checked.
        unverified.push(address);
      } else if (seen.hash === sectionFingerprint(address, root)) {
        fail(
          `refusing: ${address} байт в байт тот же текст, что был показан при взятии задачи — ` +
            `"updated" утверждает, что раздел разошёлся, но он не двигался.\n` +
            `  Либо правь раздел, либо отвечай unchanged: cli spec answer ${todo.number} unchanged ` +
            `--text "…" --address ${address}`,
        );
      }
      // The moment a delta is recorded is the moment to refuse a task link:
      // the section was just rewritten, so whoever is here can fix it, and the
      // stamp about to be written is the ONE sanctioned reference to a task.
      // `unchanged` is deliberately not gated — you did not move the section,
      // and lint already reports the link.
      const r = resolveAddress(address, root);
      const links = taskLinksIn(proseFor(r));
      if (links.length)
        fail(
          `refusing: ${address} несёт ссылк(у/и) на задачу в тексте — ` +
            links.map((l) => `${l.ref} (строка ${l.line})`).join(", ") +
            `\n  Спека — состояние, которое переживает задачи; номер задачи в ней протухает вместе с ней.` +
            `\n  Убери номер из прозы: что сделано — без ссылки, кто и когда — git blame и строка` +
            `\n  метаданных change, которую эта же команда и проставит.`,
        );
      const res = stampSection(address, { ref, root });
      if (!res.ok) fail(`refusing: ${res.reason}`);
      stamps.push(res);
    }
  }

  const at = new Date().toISOString();
  for (const address of targets) {
    const idx = answers.findIndex((a) => a && a.address === address);
    // Which BLOCKS this task moved: the ones present now that were not in the
    // baseline taken when the section was shown. Stored on the answer, so the
    // section can be read later with each bullet carrying the task that wrote
    // it — the question "which change is this bullet about" is the one a
    // section-level link could never answer.
    const seen = (Array.isArray(todo.spec_seen) ? todo.spec_seen : []).find(
      (x) => x && x.address === address,
    );
    const before = new Set(Array.isArray(seen?.blocks) ? seen.blocks : []);
    const now = verdict === "updated" ? blocksOf(address, root) : [];
    const blocks = before.size ? now.map((b) => b.hash).filter((h) => !before.has(h)) : [];
    // The section as it stands the moment the delta is claimed. Together with
    // the baseline on `spec_seen` this is the pair a diff needs, and it is
    // frozen here on purpose: the spec keeps moving after this task closes, so
    // reading "what did #341 change" off the live file would answer a different
    // question every week. Only `updated` carries one — `unchanged` asserts
    // there is no delta, and a diff of nothing against nothing is noise.
    const after = seen?.text != null && now.length ? now.map((b) => b.text).join("\n") : "";
    const entry = {
      address,
      verdict,
      note,
      at,
      ...(blocks.length ? { blocks } : {}),
      ...(after ? { after } : {}),
    };
    if (idx >= 0) answers[idx] = entry;
    else answers.push(entry);
  }
  todo.spec_answers = answers;
  todo.updated_at = at;
  saveBoard(file, data);

  if (flags.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, task: todo.number, answers, stamps, unverified }, null, 2) + "\n",
    );
    return;
  }
  for (const address of targets)
    process.stdout.write(`ok: #${todo.number} — ${address} ${verdict}\n`);
  for (const s of stamps) process.stdout.write(`   ${s.file}: ${s.stamp}\n`);
  for (const a of unverified)
    process.stdout.write(
      `   ⚠ ${a}: правку подтвердить нечем — раздел не проходил через впрыск при взятии задачи,\n` +
        `     поэтому слепка "как было" нет. Записано на слово.\n`,
    );
}

const ANSWER_USAGE =
  "usage: cli spec answer <задача> unchanged|updated --text \"<ответ по разделу>\" [--address <домен>#<слаг>]\n" +
  "       unchanged — раздел после этой работы всё ещё верен; updated — правка внесена,\n" +
  "       команда штампует updated/change в метаданных раздела. Задача с несколькими\n" +
  "       адресами отвечается по одному разделу за раз.";

const USAGE =
  "usage: cli spec domains [--json]                перечислить домены и их разделы\n" +
  "       cli spec show <домен>#<слаг> [--json]     текст адресованного раздела (или ответ\n" +
  "                                                  «домен объявлен, текст недоступен»)\n" +
  "       cli spec match \"<текст>\" [--task <N>] [--limit N] [--min 0.3] [--json]\n" +
  "                                                  какие разделы задевает этот текст — и\n" +
  "                                                  честное «раздела под это нет»\n" +
  "       cli spec refs <домен>#<слаг> [--json]     обратные ссылки: кто смотрит на этот раздел\n" +
  "       cli spec lint [--json]                    невалидные/висячие refs, потолок ~120 строк,\n" +
  "                                                  раздел без обязательного part\n" +
  "       cli spec answer <задача> unchanged|updated --text \"…\" [--address <домен>#<слаг>]\n" +
  "                                                  ответ гарду закрытия (README §8): раздел\n" +
  "                                                  держится или разошёлся; updated штампует\n" +
  "                                                  updated/change в метаданных раздела\n" +
  "       Корень реестра — настройка specRoot (settings.json), по умолчанию docs/specs.";

function cmdDomains(args) {
  const json = args.includes("--json");
  const root = resolveRoot();
  const domains = listDomainIds(root).map((id) => loadDomain(id, root));
  if (json) {
    process.stdout.write(
      JSON.stringify(
        domains.map((d) =>
          d.error
            ? { id: d.id, error: d.error }
            : {
                id: d.id,
                version: d.fm.version ?? null,
                updated: d.fm.updated ?? null,
                external: d.external ? { repo: d.external.repo ?? null, path: d.external.path ?? null } : null,
                sections: Object.entries(d.sections).map(([slug, e]) => ({
                  slug,
                  title: e?.title ?? "",
                  part: e?.part ?? "",
                  remote: Boolean(remoteLocation(e)) || Boolean(d.external),
                  anchors: e?.anchors ?? [],
                })),
              },
        ),
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (!domains.length) {
    process.stdout.write(`нет доменов в ${root}\n`);
    for (const stray of strayFiles(root))
      process.stdout.write(
        `  рядом лежит ${stray} — файл вне формы <домен>/spec.md, реестру он не виден\n`,
      );
    return;
  }
  for (const d of domains) {
    if (d.error) {
      process.stdout.write(`${d.id}: ${d.error}\n`);
      continue;
    }
    process.stdout.write(
      `${d.id}  (v${d.fm.version ?? "?"}, updated ${d.fm.updated ?? "?"})` +
        `${d.external ? `  — внешний домен, заглушка (репозиторий: ${d.external.repo})` : ""}\n`,
    );
    for (const [slug, e] of Object.entries(d.sections)) {
      const remote = remoteLocation(e) || d.external;
      process.stdout.write(
        `  ${d.id}#${slug}  [${e?.part ?? "?"}]  ${e?.title ?? ""}${remote ? `  (внешнее: ${remote.repo})` : ""}\n`,
      );
      for (const a of e?.anchors ?? [])
        process.stdout.write(`      /${a.slug}  ${a.title}\n`);
    }
  }
}

function cmdShow(args) {
  const positional = args.filter((a) => !a.startsWith("--"));
  const json = args.includes("--json");
  const address = positional[0];
  if (!address) fail(USAGE);
  const res = showSection(address);
  if (!res.ok) fail(`refusing: ${res.reason}`);
  if (json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  if (res.remote && !res.available) {
    process.stdout.write(`${address} — ${res.unavailable}\n`);
    if (res.stub) process.stdout.write("\n" + res.stub + "\n");
    return;
  }
  process.stdout.write((res.text || "(раздел пуст)") + "\n");
}

function cmdRefs(args) {
  const positional = args.filter((a) => !a.startsWith("--"));
  const json = args.includes("--json");
  const address = positional[0];
  if (!address) fail(USAGE);
  const root = resolveRoot();
  const r = resolveAddress(address, root);
  if (!r.ok) fail(`refusing: ${r.reason}`);
  const incoming = reverseRefs(address, root);
  if (json) {
    process.stdout.write(JSON.stringify({ address, refs: incoming }, null, 2) + "\n");
    return;
  }
  if (!incoming.length) {
    process.stdout.write(`${address}: на этот раздел никто не ссылается\n`);
    return;
  }
  process.stdout.write(`${address} — на него смотрят:\n` + incoming.map((a) => `  ${a}\n`).join(""));
}

// Tasks whose `spec` field names an address this registry cannot resolve.
//
// §5 lets a slug be renamed once `cli spec refs <адрес>` comes back empty — but
// `reverseRefs` only ever scanned the OTHER sections' `refs` lines, never the
// board. So the documented safety check passed cleanly while live task links
// were being broken: the one direction the registry exists to protect.
//
// The board is read through todos.mjs (dynamically, so the registry keeps no
// static dependency on it) and scoped to this project plus the global board —
// another project's tasks address another project's registry.
async function boardLinkFindings(root, cwd = process.cwd()) {
  let mod;
  try {
    mod = await import("./todos.mjs");
  } catch {
    return []; // no board reachable → nothing to say about it, never a crash
  }
  const project = path.basename(String(cwd).replace(/[\\/]+$/, ""));
  const out = [];
  // Open changes per address — two of them are two deltas being written into
  // one section at once, and the second stamp overwrites the first's provenance
  // without saying so. A warning, not an error: it is a legitimate situation
  // that needs to be SEEN, not forbidden.
  const openChanges = new Map();
  for (const t of mod.loadBoard().todos ?? []) {
    if (!t || !Array.isArray(t.spec) || !t.spec.length) continue;
    if (t.project && t.project !== project) continue;
    for (const address of t.spec) {
      const r = resolveAddress(address, root);
      if (!r.ok) {
        out.push(
          finding(
            "dangling-task-link",
            "error",
            address,
            `задача #${t.number} "${t.subject}" ссылается на ${address}, которого в реестре нет: ${r.reason}`,
          ),
        );
        continue;
      }
      if (mod.isChangeRoot(t) && !mod.isDone(t)) {
        if (!openChanges.has(address)) openChanges.set(address, []);
        openChanges.get(address).push(t);
      }
    }
  }
  for (const [address, changes] of openChanges) {
    if (changes.length < 2) continue;
    out.push(
      finding(
        "concurrent-changes",
        "warning",
        address,
        `${address}: на раздел открыто ${changes.length} change'а сразу — ` +
          changes.map((t) => `#${t.number} "${t.subject}"`).join(", ") +
          `. Штамп второго затрёт провенанс первого, а правки лягут друг на друга без предупреждения`,
      ),
    );
  }
  return out;
}

async function cmdLint(args) {
  const json = args.includes("--json");
  const root = resolveRoot();
  const findings = [...validateRegistry(root), ...(await boardLinkFindings(root))];
  const { errors, warnings } = splitFindings(findings);
  const ids = listDomainIds(root);
  const stray = strayFiles(root);
  if (json) {
    process.stdout.write(
      JSON.stringify({ ok: errors.length === 0, domains: ids, findings }, null, 2) + "\n",
    );
    if (errors.length) process.exit(1);
    return;
  }
  if (!ids.length) {
    process.stdout.write(`проверять нечего: ни одного домена в ${root}\n`);
    for (const f of stray)
      process.stdout.write(`  ${f} — файл вне формы <домен>/spec.md, реестру он не виден\n`);
    return;
  }
  if (!findings.length) {
    process.stdout.write(
      `ok: ${ids.length} домен(ов) — ${ids.join(", ")} — контракту соответствуют\n`,
    );
  } else {
    process.stdout.write(`проверено ${ids.length} домен(ов): ${ids.join(", ")}\n`);
    for (const f of findings) process.stdout.write(`  ${f.severity === "error" ? "✗" : "⚠"} ${f.message}\n`);
    process.stdout.write(`${errors.length} error(s), ${warnings.length} warning(s)\n`);
  }
  if (errors.length) process.exit(1);
}

export async function run(args) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "domains":
      cmdDomains(rest);
      break;
    case "answer":
      await cmdAnswer(rest);
      break;
    case "show":
      cmdShow(rest);
      break;
    case "refs":
      cmdRefs(rest);
      break;
    // Loaded lazily, like the CLI's own areas: the matcher pulls the board in
    // when asked about a task, and nothing else here should pay for that.
    case "match":
      await (await import("./spec-match.mjs")).run(rest);
      break;
    case "lint":
      await cmdLint(rest);
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE + "\n");
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      fail(USAGE);
  }
}
