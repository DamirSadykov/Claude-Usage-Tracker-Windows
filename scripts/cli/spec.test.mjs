import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseAddress,
  resolveAddress,
  listDomainIds,
  loadDomain,
  showSection,
  reverseRefs,
  validateRegistry,
  stampSection,
  taskLinksIn,
  fileClaimOf,
  sectionBlocks,
  sectionFingerprint,
  blocksOf,
  SECTION_LINE_CEILING,
} from "./spec.mjs";
import { matchSections, addressesIn, stem, buildCorpus } from "./spec-match.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

function writeDomain(root, id, frontmatter, body) {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "spec.md"), `---\n${frontmatter}\n---\n${body}`);
}

const HAPPY_TASKS_FM = ["id: tasks", "version: 4", "updated: 2026-08-03", "location: local"].join("\n");

const HAPPY_TASKS_BODY = [
  "# tasks — спека конвейера задач",
  "",
  "## model — Модель и хранение",
  "",
  "part: требования",
  "",
  "Текст раздела model.",
  "",
  "## done-gate — Инварианты закрытия",
  "",
  "part: инварианты",
  "refs: usage-tracker#forecast",
  "updated: 2026-08-03 · change: t#347",
  "",
  "Текст раздела done-gate, смотрит на usage-tracker#forecast.",
  "",
].join("\n");

const HAPPY_UT_FM = ["id: usage-tracker", "version: 1", "updated: 2026-08-03"].join("\n");

const HAPPY_UT_BODY = [
  "# usage-tracker — обзорная спека",
  "",
  "## forecast — Форекаст",
  "",
  "part: требования",
  "",
  "Текст раздела forecast.",
].join("\n");

function writeHappyRegistry(root) {
  writeDomain(root, "tasks", HAPPY_TASKS_FM, HAPPY_TASKS_BODY);
  writeDomain(root, "usage-tracker", HAPPY_UT_FM, HAPPY_UT_BODY);
}

describe("spec registry — parsing and address resolution (unit)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-"));
    writeHappyRegistry(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("parses <домен>#<слаг>[/<якорь>] and rejects anything else", () => {
    expect(parseAddress("tasks#done-gate")).toEqual({
      domain: "tasks",
      slug: "done-gate",
      anchor: null,
    });
    expect(parseAddress("tasks#done-gate/force")).toEqual({
      domain: "tasks",
      slug: "done-gate",
      anchor: "force",
    });
    expect(parseAddress("tasks")).toBeNull();
    expect(parseAddress("#done-gate")).toBeNull();
    expect(parseAddress("tasks#")).toBeNull();
    expect(parseAddress("tasks#done-gate/")).toBeNull();
    expect(parseAddress("tasks#done-gate/a/b")).toBeNull();
    expect(parseAddress("")).toBeNull();
  });

  it("lists the domains present under the root", () => {
    expect(listDomainIds(dir)).toEqual(["tasks", "usage-tracker"]);
  });

  it("loads a domain's sections and their metadata straight from the body's headings", () => {
    const dom = loadDomain("tasks", dir);
    expect(dom.error).toBeUndefined();
    expect(dom.fm.id).toBe("tasks");
    expect(Object.keys(dom.sections)).toEqual(["model", "done-gate"]);
    expect(dom.sections.model.part).toBe("требования");
    expect(dom.sections["done-gate"].part).toBe("инварианты");
    expect(dom.sections["done-gate"].refs).toEqual(["usage-tracker#forecast"]);
    expect(dom.sections["done-gate"].updated).toBe("2026-08-03");
    expect(dom.sections["done-gate"].change).toBe("t#347");
    expect(dom.headings.get("model").title).toBe("Модель и хранение");
    expect(dom.headings.get("done-gate").text).toMatch(/Инварианты закрытия/);
  });

  it("parses metadata split across separate lines the same as combined on one with ·", () => {
    writeDomain(
      dir,
      "twoline",
      ["id: twoline", "version: 1"].join("\n"),
      ["## a — A", "", "part: инварианты", "updated: 2026-08-03", "change: t#1", "", "text"].join("\n"),
    );
    writeDomain(
      dir,
      "combined",
      ["id: combined", "version: 1"].join("\n"),
      ["## a — A", "", "part: инварианты", "updated: 2026-08-03 · change: t#1", "", "text"].join("\n"),
    );
    const twoLine = loadDomain("twoline", dir).sections.a;
    const combined = loadDomain("combined", dir).sections.a;
    expect(twoLine.updated).toBe("2026-08-03");
    expect(twoLine.change).toBe("t#1");
    expect(combined.updated).toBe(twoLine.updated);
    expect(combined.change).toBe(twoLine.change);
  });

  it("parses refs as a list of several comma-separated addresses", () => {
    writeDomain(
      dir,
      "multiref",
      ["id: multiref", "version: 1"].join("\n"),
      ["## a — A", "", "part: требования", "refs: tasks#model, usage-tracker#forecast", "", "text"].join("\n"),
    );
    expect(loadDomain("multiref", dir).sections.a.refs).toEqual(["tasks#model", "usage-tracker#forecast"]);
  });

  it("stops the metadata block at the first non key: value line — a prose line that looks like one, further down, stays prose", () => {
    writeDomain(
      dir,
      "prosetest",
      ["id: prosetest", "version: 1"].join("\n"),
      [
        "## a — A",
        "",
        "part: требования",
        "",
        "Обычный текст раздела.",
        "",
        "домен: значение-подобное, но это проза",
      ].join("\n"),
    );
    const dom = loadDomain("prosetest", dir);
    expect(dom.sections.a.part).toBe("требования");
    expect(dom.headings.get("a").lineCount).toBe(3);
    expect(dom.headings.get("a").text).toMatch(/домен: значение-подобное, но это проза/);
  });

  it("resolves a valid address and refuses an address whose domain or slug does not exist", () => {
    expect(resolveAddress("tasks#model", dir).ok).toBe(true);
    const noDomain = resolveAddress("nope#model", dir);
    expect(noDomain.ok).toBe(false);
    expect(noDomain.reason).toMatch(/нет такого домена "nope"/);
    const noSlug = resolveAddress("tasks#nope", dir);
    expect(noSlug.ok).toBe(false);
    expect(noSlug.reason).toMatch(/нет раздела "nope"/);
    const malformed = resolveAddress("tasks", dir);
    expect(malformed.ok).toBe(false);
    expect(malformed.reason).toMatch(/не адрес/);
  });

  it("show returns the section's own text, heading included, nothing from its neighbour", () => {
    const res = showSection("tasks#model", dir);
    expect(res.ok).toBe(true);
    expect(res.remote).toBe(false);
    expect(res.text).toMatch(/## model — Модель и хранение/);
    expect(res.text).not.toMatch(/done-gate/);
  });

  it("show includes part and refs, but leaves updated/change out as reading noise", () => {
    const res = showSection("tasks#done-gate", dir);
    expect(res.ok).toBe(true);
    expect(res.text).toMatch(/## done-gate — Инварианты закрытия/);
    expect(res.text).toMatch(/part: инварианты/);
    expect(res.text).toMatch(/refs: usage-tracker#forecast/);
    expect(res.text).not.toMatch(/change: t#347/);
    expect(res.text).not.toMatch(/updated: 2026-08-03/);
  });

  it("reverse refs: usage-tracker#forecast is pointed at by tasks#done-gate, and nothing points at tasks#model", () => {
    expect(reverseRefs("usage-tracker#forecast", dir)).toEqual(["tasks#done-gate"]);
    expect(reverseRefs("tasks#model", dir)).toEqual([]);
  });

  it("lints a registry that keeps every invariant as clean", () => {
    expect(validateRegistry(dir)).toEqual([]);
  });
});

describe("spec registry — an unavailable location is its own answer, not an error or silence", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-remote-"));
    writeDomain(
      dir,
      "product",
      ["id: product", "version: 1", "updated: 2026-08-03"].join("\n"),
      [
        "# product",
        "",
        "## closed-part — Закрытая часть подсистемы",
        "",
        "part: устройство",
        "location: repo=private path=specs/product/spec.md",
        "",
        "Раздел живёт в приватном репозитории.",
      ].join("\n"),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("parses a section-level location: repo=… path=… line into {repo, path}", () => {
    expect(loadDomain("product", dir).sections["closed-part"].location).toEqual({
      repo: "private",
      path: "specs/product/spec.md",
    });
  });

  it("address exists — a remote section is never dangling for lacking a local repo", () => {
    expect(resolveAddress("product#closed-part", dir).ok).toBe(true);
    expect(validateRegistry(dir)).toEqual([]);
  });

  it("show says the domain is declared and the text is unavailable, naming what's missing, when the repo key is unconfigured", () => {
    const res = showSection("product#closed-part", dir);
    expect(res.ok).toBe(true);
    expect(res.remote).toBe(true);
    expect(res.available).toBe(false);
    expect(res.unavailable).toMatch(/домен объявлен, текст недоступен/);
    expect(res.unavailable).toMatch(/"private"/);
  });

  it("show reads the real text once the repo is configured and the file is there", () => {
    const externalRoot = mkdtempSync(path.join(os.tmpdir(), "cut-spec-external-"));
    mkdirSync(path.join(externalRoot, "specs", "product"), { recursive: true });
    writeFileSync(
      path.join(externalRoot, "specs", "product", "spec.md"),
      "содержимое закрытой части подсистемы",
    );
    const appData = mkdtempSync(path.join(os.tmpdir(), "cut-spec-appdata-"));
    mkdirSync(path.join(appData, "com.claude-usage-tracker.app"), { recursive: true });
    writeFileSync(
      path.join(appData, "com.claude-usage-tracker.app", "settings.json"),
      JSON.stringify({ specRepos: { private: externalRoot } }),
    );
    try {
      const res = showSection("product#closed-part", dir, appData);
      expect(res.available).toBe(true);
      expect(res.text).toBe("содержимое закрытой части подсистемы");
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(appData, { recursive: true, force: true });
    }
  });
});

describe("spec registry — an external DOMAIN is a stub, not a body", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-extdomain-"));
    writeDomain(
      dir,
      "payments",
      [
        "id: payments",
        "version: 2",
        "updated: 2026-08-03",
        "location:",
        "  repo: partner",
        "  path: specs/payments/spec.md",
      ].join("\n"),
      [
        "## billing — Биллинг",
        "",
        "part: требования",
        "",
        "## refunds — Возвраты",
        "",
        "part: инварианты",
        "refs: tasks#done-gate",
      ].join("\n"),
    );
    writeDomain(
      dir,
      "tasks",
      ["id: tasks", "version: 1"].join("\n"),
      ["## done-gate — Инварианты закрытия", "", "part: инварианты", "", "текст"].join("\n"),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the stub is a real domain — listed, addressable, and refs resolve through it", () => {
    expect(listDomainIds(dir)).toContain("payments");
    expect(resolveAddress("payments#billing", dir).ok).toBe(true);
    expect(loadDomain("payments", dir).external).toEqual({ repo: "partner", path: "specs/payments/spec.md" });
    expect(reverseRefs("tasks#done-gate", dir)).toEqual(["payments#refunds"]);
  });

  it("a ref TO a section of an external domain is not dangling — the address exists", () => {
    const findings = validateRegistry(dir);
    expect(findings.some((f) => f.rule === "dangling-ref")).toBe(false);
  });

  it("lint does not fault the stub for its headings carrying no prose", () => {
    const findings = validateRegistry(dir);
    expect(findings.some((f) => f.rule === "section-too-long")).toBe(false);
    expect(findings.some((f) => f.rule === "missing-part")).toBe(false);
  });

  it("lint DOES fault a domain-level location missing repo or path", () => {
    const broken = mkdtempSync(path.join(os.tmpdir(), "cut-spec-extdomain-broken-"));
    writeDomain(
      broken,
      "payments",
      ["id: payments", "version: 1", "location:", "  repo: partner"].join("\n"),
      ["## billing — Биллинг", "", "part: требования"].join("\n"),
    );
    const findings = validateRegistry(broken);
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: "malformed-location", severity: "error" }),
    );
    rmSync(broken, { recursive: true, force: true });
  });

  it("show says unavailable and names the repo, when the external repo is not configured", () => {
    const res = showSection("payments#billing", dir);
    expect(res.ok).toBe(true);
    expect(res.remote).toBe(true);
    expect(res.available).toBe(false);
    expect(res.unavailable).toMatch(/домен объявлен, текст недоступен/);
    expect(res.unavailable).toMatch(/"partner"/);
  });

  it("show reads the matching section off the external spec.md once the repo is configured", () => {
    const externalRoot = mkdtempSync(path.join(os.tmpdir(), "cut-spec-extdomain-repo-"));
    mkdirSync(path.join(externalRoot, "specs", "payments"), { recursive: true });
    writeFileSync(
      path.join(externalRoot, "specs", "payments", "spec.md"),
      [
        "---",
        "id: payments",
        "version: 5",
        "---",
        "## billing — Биллинг",
        "",
        "part: требования",
        "",
        "Полный текст биллинга на той стороне.",
      ].join("\n"),
    );
    const appData = mkdtempSync(path.join(os.tmpdir(), "cut-spec-extdomain-appdata-"));
    mkdirSync(path.join(appData, "com.claude-usage-tracker.app"), { recursive: true });
    writeFileSync(
      path.join(appData, "com.claude-usage-tracker.app", "settings.json"),
      JSON.stringify({ specRepos: { partner: externalRoot } }),
    );
    try {
      const res = showSection("payments#billing", dir, appData);
      expect(res.available).toBe(true);
      expect(res.text).toMatch(/Полный текст биллинга/);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(appData, { recursive: true, force: true });
    }
  });
});

describe("spec registry — lint catches what a growing file rots into", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-lint-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("errors when the directory name and frontmatter id disagree", () => {
    writeDomain(
      dir,
      "tasks",
      ["id: other", "version: 1"].join("\n"),
      ["## a — A", "", "part: требования", "", "text"].join("\n"),
    );
    const findings = validateRegistry(dir);
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: "id-mismatch", severity: "error" }),
    );
  });

  it("errors on a dangling ref — a domain that does not exist", () => {
    writeDomain(
      dir,
      "tasks",
      ["id: tasks", "version: 1"].join("\n"),
      ["## a — A", "", "part: требования", "refs: gone#somewhere", "", "text"].join("\n"),
    );
    const findings = validateRegistry(dir);
    expect(findings).toContainEqual(expect.objectContaining({ rule: "dangling-ref", severity: "error" }));
  });

  it("errors on a dangling ref — a slug that was removed from an existing domain", () => {
    writeDomain(
      dir,
      "tasks",
      ["id: tasks", "version: 1"].join("\n"),
      ["## a — A", "", "part: требования", "refs: tasks#gone", "", "text"].join("\n"),
    );
    const findings = validateRegistry(dir);
    expect(findings).toContainEqual(expect.objectContaining({ rule: "dangling-ref", severity: "error" }));
  });

  it("warns, does not error, once a section outgrows the ~120 line ceiling — counted on prose, not metadata", () => {
    const long = Array.from({ length: SECTION_LINE_CEILING + 5 }, (_, i) => `строка ${i}`).join("\n");
    writeDomain(
      dir,
      "tasks",
      ["id: tasks", "version: 1"].join("\n"),
      ["## a — A", "", "part: требования", "", long].join("\n"),
    );
    const findings = validateRegistry(dir);
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: "section-too-long", severity: "warning" }),
    );
    expect(findings.some((f) => f.severity === "error")).toBe(false);
  });

  it("errors — missing-part — when a section declares no part at all", () => {
    writeDomain(
      dir,
      "tasks",
      ["id: tasks", "version: 1"].join("\n"),
      ["## a — A", "", "текст без единой строки метаданных"].join("\n"),
    );
    const findings = validateRegistry(dir);
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: "missing-part", severity: "error" }),
    );
  });

  it("errors on a part value outside требования|устройство|инварианты", () => {
    writeDomain(
      dir,
      "tasks",
      ["id: tasks", "version: 1"].join("\n"),
      ["## a — A", "", "part: непонятно", "", "text"].join("\n"),
    );
    const findings = validateRegistry(dir);
    expect(findings).toContainEqual(expect.objectContaining({ rule: "invalid-part", severity: "error" }));
  });
});

describe("cli spec — command wiring", () => {
  let dir;
  const run = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, "spec", ...args], {
          encoding: "utf8",
          cwd: dir,
          windowsHide: true,
        }),
      };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-cli-"));
    writeHappyRegistry(path.join(dir, "docs", "specs"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("domains lists both domains and their sections", () => {
    const { code, out } = run("domains");
    expect(code).toBe(0);
    expect(out).toMatch(/tasks/);
    expect(out).toMatch(/tasks#model/);
    expect(out).toMatch(/tasks#done-gate/);
    expect(out).toMatch(/usage-tracker#forecast/);
  });

  it("domains --json is machine-readable", () => {
    const r = JSON.parse(run("domains", "--json").out);
    const tasks = r.find((d) => d.id === "tasks");
    expect(tasks.sections.map((s) => s.slug)).toEqual(["model", "done-gate"]);
  });

  it("show prints the addressed section's text", () => {
    const { code, out } = run("show", "tasks#done-gate");
    expect(code).toBe(0);
    expect(out).toMatch(/## done-gate — Инварианты закрытия/);
  });

  it("show refuses an address whose slug does not exist, and exits non-zero", () => {
    const { code, out } = run("show", "tasks#gone");
    expect(code).not.toBe(0);
    expect(out).toMatch(/refusing/);
    expect(out).toMatch(/нет раздела/);
  });

  it("refs shows who points at a section", () => {
    const { code, out } = run("refs", "usage-tracker#forecast");
    expect(code).toBe(0);
    expect(out).toMatch(/tasks#done-gate/);
  });

  it("lint says the fixture registry keeps the contract, and names what it covered", () => {
    const { code, out } = run("lint");
    expect(code).toBe(0);
    expect(out).toMatch(/ok:/);
    expect(out).toMatch(/tasks/);
    expect(out).toMatch(/usage-tracker/);
  });

  it("an empty registry is not a green light — lint says there is nothing to check and names the stray files", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "spec-empty-"));
    const root = path.join(empty, "docs", "specs");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "tasks.md"), "# старая форма\n");
    writeFileSync(path.join(root, "README.md"), "# правила жанра\n");
    const out = execFileSync(process.execPath, [cli, "spec", "lint"], {
      cwd: empty,
      encoding: "utf8",
    });
    expect(out).not.toMatch(/^ok:/m);
    expect(out).toMatch(/проверять нечего/);
    expect(out).toMatch(/tasks\.md/);
    expect(out).not.toMatch(/README\.md/);
    rmSync(empty, { recursive: true, force: true });
  });

  it("domains marks an external domain instead of skipping or crashing on it", () => {
    writeDomain(
      path.join(dir, "docs", "specs"),
      "payments",
      [
        "id: payments",
        "version: 1",
        "location:",
        "  repo: partner",
        "  path: specs/payments/spec.md",
      ].join("\n"),
      ["## billing — Биллинг", "", "part: требования"].join("\n"),
    );
    const { code, out } = run("domains");
    expect(code).toBe(0);
    expect(out).toMatch(/payments.*внешний домен/);
    expect(out).toMatch(/payments#billing/);
    const json = JSON.parse(run("domains", "--json").out);
    const adv = json.find((d) => d.id === "payments");
    expect(adv.external).toEqual({ repo: "partner", path: "specs/payments/spec.md" });
  });

  it("lint exits 1 and names the rule when the registry is broken", () => {
    writeDomain(
      path.join(dir, "docs", "specs"),
      "broken",
      ["id: broken", "version: 1"].join("\n"),
      ["## x — X", "", "текст без part"].join("\n"),
    );
    const { code, out } = run("lint");
    expect(code).toBe(1);
    expect(out).toMatch(/missing-part|error\(s\)/);
  });
});

describe("cli todos set spec — validated against the registry at write time", () => {
  let dir;
  let boardFile;
  const savedAppData = process.env.APPDATA;

  const task = (n, extra = {}) => ({ id: `t${n}`, number: n, subject: `узел ${n}`, status: "queue", ...extra });
  const board = (...todos) => writeFileSync(boardFile, JSON.stringify({ version: 1, todos }, null, 2));

  const todosCli = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, "todos", ...args], {
          encoding: "utf8",
          cwd: dir,
          env: { ...process.env, APPDATA: dir },
          windowsHide: true,
        }),
      };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-set-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    boardFile = path.join(dir, "com.claude-usage-tracker.app", "todos.json");
    writeHappyRegistry(path.join(dir, "docs", "specs"));
    board(task(1));
  });

  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a valid single address and stores it as a list", () => {
    const { code, out } = todosCli("set", "spec", "1", "tasks#done-gate");
    expect(code).toBe(0);
    expect(out).toMatch(/spec -> tasks#done-gate/);
    const saved = JSON.parse(readFileSync(boardFile, "utf8")).todos[0];
    expect(saved.spec).toEqual(["tasks#done-gate"]);
  });

  it("accepts several comma-separated addresses across domains", () => {
    todosCli("set", "spec", "1", "tasks#model,usage-tracker#forecast");
    const saved = JSON.parse(readFileSync(boardFile, "utf8")).todos[0];
    expect(saved.spec).toEqual(["tasks#model", "usage-tracker#forecast"]);
  });

  it("refuses an invalid address and leaves the board untouched", () => {
    const before = readFileSync(boardFile, "utf8");
    const { code, out } = todosCli("set", "spec", "1", "tasks#no-such-section");
    expect(code).not.toBe(0);
    expect(out).toMatch(/refusing: invalid spec address/);
    expect(readFileSync(boardFile, "utf8")).toBe(before);
  });

  it("refuses the whole write when one of several addresses is invalid", () => {
    const before = readFileSync(boardFile, "utf8");
    const { code } = todosCli("set", "spec", "1", "tasks#model,tasks#gone");
    expect(code).not.toBe(0);
    expect(readFileSync(boardFile, "utf8")).toBe(before);
  });

  it("none clears a previously set link", () => {
    todosCli("set", "spec", "1", "tasks#model");
    const { code, out } = todosCli("set", "spec", "1", "none");
    expect(code).toBe(0);
    expect(out).toMatch(/spec link cleared/);
    const saved = JSON.parse(readFileSync(boardFile, "utf8")).todos[0];
    expect(saved.spec).toBeUndefined();
  });
});

describe("stampSection — the registry's one write path (t#341)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-stamp-"));
    writeHappyRegistry(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds updated/change to a section that had no provenance, leaving part alone", () => {
    const res = stampSection("tasks#model", { ref: "t#341", date: "2026-08-03", root: dir });
    expect(res.ok).toBe(true);
    const sec = loadDomain("tasks", dir).sections.model;
    expect(sec.part).toBe("требования");
    expect(sec.updated).toBe("2026-08-03");
    expect(sec.change).toBe("t#341");
  });

  it("replaces an existing stamp instead of adding a second one", () => {
    stampSection("tasks#done-gate", { ref: "t#341", date: "2026-08-04", root: dir });
    const raw = readFileSync(path.join(dir, "tasks", "spec.md"), "utf8");
    // Only the section's own stamp is rewritten — the file's frontmatter keeps
    // its own `updated`, which is about the FILE, not this section (README §4).
    const section = raw.slice(raw.indexOf("## done-gate"));
    expect(section.match(/updated: /g)).toHaveLength(1);
    expect(raw).not.toMatch(/t#347/);
    const sec = loadDomain("tasks", dir).sections["done-gate"];
    expect(sec.updated).toBe("2026-08-04");
    expect(sec.change).toBe("t#341");
    expect(sec.refs).toEqual(["usage-tracker#forecast"]);
  });

  it("leaves every other section's text byte-for-byte alone", () => {
    const before = readFileSync(path.join(dir, "usage-tracker", "spec.md"), "utf8");
    stampSection("tasks#model", { ref: "t#341", date: "2026-08-03", root: dir });
    expect(readFileSync(path.join(dir, "usage-tracker", "spec.md"), "utf8")).toBe(before);
    expect(loadDomain("tasks", dir).headings.get("done-gate").text).toMatch(
      /Текст раздела done-gate/,
    );
  });

  it("keeps a neighbouring pair when it shared the line with the stamp", () => {
    writeDomain(
      dir,
      "shared",
      ["id: shared", "version: 1"].join("\n"),
      ["## a — A", "", "part: устройство · updated: 2026-01-01 · change: t#1", "", "текст"].join("\n"),
    );
    stampSection("shared#a", { ref: "t#341", date: "2026-08-03", root: dir });
    const sec = loadDomain("shared", dir).sections.a;
    expect(sec.part).toBe("устройство");
    expect(sec.change).toBe("t#341");
  });

  it("refuses an address the registry does not know instead of writing anything", () => {
    const before = readFileSync(path.join(dir, "tasks", "spec.md"), "utf8");
    expect(stampSection("tasks#gone", { ref: "t#341", root: dir }).ok).toBe(false);
    expect(readFileSync(path.join(dir, "tasks", "spec.md"), "utf8")).toBe(before);
  });
});

describe("cli spec answer — the structural closing answer (t#341)", () => {
  let dir;
  let boardFile;

  const task = (n, extra = {}) => ({
    id: `t${n}`,
    number: n,
    subject: `узел ${n}`,
    status: "review",
    ...extra,
  });
  const board = (...todos) => writeFileSync(boardFile, JSON.stringify({ version: 1, todos }, null, 2));
  const saved = (n = 0) => JSON.parse(readFileSync(boardFile, "utf8")).todos[n];

  const specCli = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, "spec", ...args], {
          encoding: "utf8",
          cwd: dir,
          env: { ...process.env, APPDATA: dir },
          windowsHide: true,
        }),
      };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };

  const NOTE = "раздел про модель после этой работы всё ещё описывает её верно";
  const NOTE2 = "второй раздел тоже проверен и расходится с кодом ровно в одном пункте";

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-answer-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    boardFile = path.join(dir, "com.claude-usage-tracker.app", "todos.json");
    writeHappyRegistry(path.join(dir, "docs", "specs"));
    board(task(1, { spec: ["tasks#model"] }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records unchanged on the task without touching the spec file", () => {
    const before = readFileSync(path.join(dir, "docs", "specs", "tasks", "spec.md"), "utf8");
    const { code } = specCli("answer", "1", "unchanged", "--text", NOTE);
    expect(code).toBe(0);
    expect(saved().spec_answers).toHaveLength(1);
    expect(saved().spec_answers[0]).toMatchObject({
      address: "tasks#model",
      verdict: "unchanged",
      note: NOTE,
    });
    expect(readFileSync(path.join(dir, "docs", "specs", "tasks", "spec.md"), "utf8")).toBe(before);
  });

  it("records updated AND stamps the section's provenance", () => {
    const { code, out } = specCli("answer", "1", "updated", "--text", NOTE);
    expect(code).toBe(0);
    expect(out).toMatch(/updated: \d{4}-\d{2}-\d{2} · change: t#1/);
    const sec = loadDomain("tasks", path.join(dir, "docs", "specs")).sections.model;
    expect(sec.change).toBe("t#1");
    expect(saved().spec_answers[0].verdict).toBe("updated");
  });

  it("stamps the CHANGE, not the step, when the task hangs under a change root", () => {
    board(
      task(1, { spec: ["tasks#model"], depends_on: [] }),
      task(9, { change: true, status: "in_progress", depends_on: ["t1"] }),
    );
    expect(specCli("answer", "1", "updated", "--text", NOTE).code).toBe(0);
    expect(loadDomain("tasks", path.join(dir, "docs", "specs")).sections.model.change).toBe("t#9");
  });

  it("refuses a one-liner receipt", () => {
    const { code, out } = specCli("answer", "1", "unchanged", "--text", "не менялось");
    expect(code).not.toBe(0);
    expect(out).toMatch(/--text is \d+ chars/);
    expect(saved().spec_answers).toBeUndefined();
  });

  it("refuses one verdict for a task addressing several sections", () => {
    board(task(1, { spec: ["tasks#model", "tasks#done-gate"] }));
    const { code, out } = specCli("answer", "1", "unchanged", "--text", NOTE);
    expect(code).not.toBe(0);
    expect(out).toMatch(/one at a time with --address/);
  });

  it("refuses the same sentence reused for a second section", () => {
    board(task(1, { spec: ["tasks#model", "tasks#done-gate"] }));
    expect(
      specCli("answer", "1", "unchanged", "--text", NOTE, "--address", "tasks#model").code,
    ).toBe(0);
    const { code, out } = specCli(
      "answer", "1", "unchanged", "--text", NOTE, "--address", "tasks#done-gate",
    );
    expect(code).not.toBe(0);
    expect(out).toMatch(/word-for-word/);
    expect(
      specCli("answer", "1", "unchanged", "--text", NOTE2, "--address", "tasks#done-gate").code,
    ).toBe(0);
    expect(saved().spec_answers).toHaveLength(2);
  });

  it("refuses an address the task does not carry", () => {
    const { code, out } = specCli(
      "answer", "1", "unchanged", "--text", NOTE, "--address", "usage-tracker#forecast",
    );
    expect(code).not.toBe(0);
    expect(out).toMatch(/does not address/);
  });

  it("refuses a task with no spec link at all", () => {
    board(task(1));
    const { code, out } = specCli("answer", "1", "unchanged", "--text", NOTE);
    expect(code).not.toBe(0);
    expect(out).toMatch(/carries no spec link/);
  });

  it("re-answering the same address replaces the entry rather than appending", () => {
    specCli("answer", "1", "unchanged", "--text", NOTE);
    specCli("answer", "1", "updated", "--text", NOTE2);
    expect(saved().spec_answers).toHaveLength(1);
    expect(saved().spec_answers[0].verdict).toBe("updated");
  });

  it("answers a section inherited from the task's change root", () => {
    board(
      task(1, { depends_on: [] }),
      task(9, { change: true, spec: ["tasks#model"], status: "in_progress", depends_on: ["t1"] }),
    );
    expect(specCli("answer", "1", "unchanged", "--text", NOTE).code).toBe(0);
    expect(saved().spec_answers[0].address).toBe("tasks#model");
  });
});

describe("no task links in a spec's prose (t#341)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-tasklink-"));
    writeHappyRegistry(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withProse = (prose) =>
    writeDomain(
      dir,
      "linked",
      ["id: linked", "version: 1"].join("\n"),
      ["## a — A", "", "part: устройство", "", prose, ""].join("\n"),
    );

  it("lint refuses a task reference in the section's text", () => {
    withProse("Реестр построен в t#339 и читает домены.");
    const f = validateRegistry(dir).filter((x) => x.rule === "task-link");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
    expect(f[0].address).toBe("linked#a");
  });

  it("the `change:` stamp is the ONE sanctioned reference and stays legal", () => {
    // done-gate in the happy registry carries `updated: … · change: t#347`.
    expect(validateRegistry(dir).filter((x) => x.rule === "task-link")).toEqual([]);
  });

  it("finds every reference, not just the first", () => {
    withProse("Сделано в t#339, чинится в t#341, ждёт t#342.");
    expect(validateRegistry(dir).filter((x) => x.rule === "task-link")).toHaveLength(3);
  });

  it("a bare #N is a PR/issue by this project's convention and is left alone", () => {
    withProse("Поведение задано в #141 и с тех пор не менялось.");
    expect(validateRegistry(dir).filter((x) => x.rule === "task-link")).toEqual([]);
  });

  it("taskLinksIn reports the prose line so the message can point at it", () => {
    expect(taskLinksIn(["первая", "вторая с t#7"])).toEqual([
      { line: 2, ref: "t#7", text: "вторая с t#7" },
    ]);
  });
});

describe("cli spec answer updated — refuses to stamp a section holding a task link", () => {
  let dir;
  let boardFile;
  const NOTE = "раздел переписан под новую механику и больше не описывает старый ритуал";

  const specCli = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, "spec", ...args], {
          encoding: "utf8",
          cwd: dir,
          env: { ...process.env, APPDATA: dir },
          windowsHide: true,
        }),
      };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-answer-link-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    boardFile = path.join(dir, "com.claude-usage-tracker.app", "todos.json");
    writeHappyRegistry(path.join(dir, "docs", "specs"));
    writeFileSync(
      boardFile,
      JSON.stringify(
        {
          version: 1,
          todos: [{ id: "t1", number: 1, subject: "узел 1", status: "review", spec: ["tasks#model"] }],
        },
        null,
        2,
      ),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pollute = () => {
    const f = path.join(dir, "docs", "specs", "tasks", "spec.md");
    writeFileSync(
      f,
      readFileSync(f, "utf8").replace("Текст раздела model.", "Текст раздела model, построен в t#339."),
    );
  };

  it("refuses, names the reference, and leaves the file untouched", () => {
    pollute();
    const f = path.join(dir, "docs", "specs", "tasks", "spec.md");
    const before = readFileSync(f, "utf8");
    const { code, out } = specCli("answer", "1", "updated", "--text", NOTE);
    expect(code).not.toBe(0);
    expect(out).toMatch(/t#339/);
    expect(readFileSync(f, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(boardFile, "utf8")).todos[0].spec_answers).toBeUndefined();
  });

  it("`unchanged` is NOT gated — you did not move the section", () => {
    pollute();
    expect(specCli("answer", "1", "unchanged", "--text", NOTE).code).toBe(0);
  });

  it("stamps normally once the reference is gone", () => {
    expect(specCli("answer", "1", "updated", "--text", NOTE).code).toBe(0);
    expect(loadDomain("tasks", path.join(dir, "docs", "specs")).sections.model.change).toBe("t#1");
  });
});

// --- what the audit found, now held down by tests ---------------------------
//
// Each of these was a live hole: the registry answered confidently about a
// section that had been swallowed, `unchanged` cleared the guard for an address
// that no longer existed, and the link could be dropped off a closing task
// without a trace. They share a shape — the CHEAP path was the unguarded one.

describe("a slug declared twice (audit 1.3)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-dup-"));
    writeDomain(
      dir,
      "demo",
      ["id: demo", "version: 1"].join("\n"),
      [
        "## alpha — Раздел А",
        "",
        "part: устройство",
        "",
        "Первый текст.",
        "",
        "## alpha — Дубль того же слага",
        "",
        "part: устройство",
        "",
        "Второй текст.",
      ].join("\n"),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is an error, not a silent overwrite of the first section", () => {
    const f = validateRegistry(dir).filter((x) => x.rule === "duplicate-slug");
    expect(f).toHaveLength(1);
    expect(f[0].address).toBe("demo#alpha");
  });

  it("stampSection refuses rather than stamping whichever heading it hit first", () => {
    const before = readFileSync(path.join(dir, "demo", "spec.md"), "utf8");
    const res = stampSection("demo#alpha", { ref: "t#1", root: dir });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/объявлен 2 раза/);
    expect(readFileSync(path.join(dir, "demo", "spec.md"), "utf8")).toBe(before);
  });
});

describe("answering about an address the registry lost (audit 1.2)", () => {
  let dir;
  let boardFile;
  const NOTE = "раздел после этой работы всё ещё описывает поведение верно и правки не требует";

  const specCli = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, "spec", ...args], {
          encoding: "utf8",
          cwd: dir,
          env: { ...process.env, APPDATA: dir },
          windowsHide: true,
        }),
      };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-lost-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    boardFile = path.join(dir, "com.claude-usage-tracker.app", "todos.json");
    writeHappyRegistry(path.join(dir, "docs", "specs"));
    writeFileSync(
      boardFile,
      JSON.stringify(
        {
          version: 1,
          todos: [{ id: "t1", number: 1, subject: "узел 1", status: "review", spec: ["tasks#model"] }],
        },
        null,
        2,
      ),
    );
    // The slug is renamed AFTER the link was written — the case §5 allows and
    // the board never hears about.
    const f = path.join(dir, "docs", "specs", "tasks", "spec.md");
    writeFileSync(f, readFileSync(f, "utf8").replace("## model —", "## model-renamed —"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("`unchanged` refuses too — the cheap verdict used to be the unguarded one", () => {
    const { code, out } = specCli("answer", "1", "unchanged", "--text", NOTE);
    expect(code).not.toBe(0);
    expect(out).toMatch(/нет раздела "model"/);
    expect(JSON.parse(readFileSync(boardFile, "utf8")).todos[0].spec_answers).toBeUndefined();
  });

  it("lint reports the task's dangling link, which reverseRefs never saw", () => {
    const { code, out } = (() => {
      try {
        return {
          code: 0,
          out: execFileSync(process.execPath, [cli, "spec", "lint"], {
            encoding: "utf8",
            cwd: dir,
            env: { ...process.env, APPDATA: dir },
            windowsHide: true,
          }),
        };
      } catch (e) {
        return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
      }
    })();
    expect(code).not.toBe(0);
    expect(out).toMatch(/задача #1 .* ссылается на tasks#model/);
  });
});

describe("cli todos set spec none — refused on a closing task (audit 1.1)", () => {
  let dir;
  let boardFile;

  const todosCli = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, "todos", ...args], {
          encoding: "utf8",
          cwd: dir,
          env: { ...process.env, APPDATA: dir },
          windowsHide: true,
        }),
      };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };
  const board = (status) =>
    writeFileSync(
      boardFile,
      JSON.stringify(
        {
          version: 1,
          todos: [{ id: "t1", number: 1, subject: "узел 1", status, spec: ["tasks#model"] }],
        },
        null,
        2,
      ),
    );

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-disarm-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    boardFile = path.join(dir, "com.claude-usage-tracker.app", "todos.json");
    writeHappyRegistry(path.join(dir, "docs", "specs"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses on review and keeps the link", () => {
    board("review");
    const { code, out } = todosCli("set", "spec", "1", "none");
    expect(code).not.toBe(0);
    expect(out).toMatch(/disarm the closing guard/);
    expect(JSON.parse(readFileSync(boardFile, "utf8")).todos[0].spec).toEqual(["tasks#model"]);
  });

  it("refuses on done as well", () => {
    board("done");
    expect(todosCli("set", "spec", "1", "none").code).not.toBe(0);
  });

  it("still clears freely while the work is open", () => {
    board("in_progress");
    expect(todosCli("set", "spec", "1", "none").code).toBe(0);
    expect(JSON.parse(readFileSync(boardFile, "utf8")).todos[0].spec).toBeUndefined();
  });
});

describe("a section's file claims must resolve (t#350)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-claims-"));
    mkdirSync(path.join(dir, "src", "nested"), { recursive: true });
    writeFileSync(path.join(dir, "src", "nested", "real.ts"), "x");
    writeFileSync(path.join(dir, "src", "solo.mjs"), "x");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withProse = (prose) =>
    writeDomain(
      path.join(dir, "specs"),
      "a",
      ["id: a", "version: 1"].join("\n"),
      ["## s — S", "", "part: устройство", "", prose].join("\n"),
    );
  const claims = () =>
    validateRegistry(path.join(dir, "specs"), dir).filter((f) => f.rule === "missing-path");

  it("passes a bare filename and a path that exist", () => {
    withProse("Читает `solo.mjs` и `src/nested/real.ts`.");
    expect(claims()).toEqual([]);
  });

  it("accepts a path written the readable way, not from the repo root", () => {
    withProse("Разбор живёт в `nested/real.ts`.");
    expect(claims()).toEqual([]);
  });

  it("catches a file that was renamed away", () => {
    withProse("Читает `gone.mjs` и `src/gone.rs`.");
    expect(claims().map((f) => f.message.match(/`([^`]+)`/)[1]).sort()).toEqual([
      "gone.mjs",
      "src/gone.rs",
    ]);
  });

  it("keeps the symbol after :: out of the claim", () => {
    withProse("Смотри `solo.mjs::specAddressesFor`.");
    expect(claims()).toEqual([]);
  });

  it("stays out of everything that is not a claim about a repo file", () => {
    // Runtime data outside the repo, a home path, a template, a URL, prose.
    withProse(
      "Пишет в `todos.json`, читает `~/.claude/settings.json`, форма `<домен>/spec.md`, " +
        "ссылка `https://x.dev/a.ts`, поле `part: требования`.",
    );
    expect(claims()).toEqual([]);
  });

  it("fileClaimOf classifies the boundary cases directly", () => {
    expect(fileClaimOf("todos.mjs::fn")).toBe("todos.mjs");
    expect(fileClaimOf("insightHelp/render.ts")).toBe("insightHelp/render.ts");
    expect(fileClaimOf("todos.json")).toBeNull(); // bare data file → not ours
    expect(fileClaimOf("docs/plan-format.md")).toBe("docs/plan-format.md"); // with a path → ours
    expect(fileClaimOf("~/.claude/settings.json")).toBeNull();
    expect(fileClaimOf("C:/x/y.rs")).toBeNull();
    expect(fileClaimOf("part: требования")).toBeNull();
  });
});

describe("`updated` must be backed by an actual edit (t#352)", () => {
  let dir;
  let boardFile;
  const NOTE = "раздел переписан под новую механику и больше не описывает старый ритуал";
  const specFile = () => path.join(dir, "docs", "specs", "tasks", "spec.md");

  const cliRun = (area, ...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, area, ...args], {
          encoding: "utf8",
          cwd: dir,
          env: { ...process.env, APPDATA: dir },
          windowsHide: true,
        }),
      };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };
  const saved = () => JSON.parse(readFileSync(boardFile, "utf8")).todos[0];

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-baseline-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    boardFile = path.join(dir, "com.claude-usage-tracker.app", "todos.json");
    writeHappyRegistry(path.join(dir, "docs", "specs"));
    writeFileSync(
      boardFile,
      JSON.stringify(
        {
          version: 1,
          todos: [{ id: "t1", number: 1, subject: "узел 1", status: "queue", spec: ["tasks#model"] }],
        },
        null,
        2,
      ),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Taking the task is what records the baseline — the anchor where the section
  // is actually shown to the session.
  const take = () => cliRun("todos", "set", "status", "1", "in_progress");
  const edit = () =>
    writeFileSync(
      specFile(),
      readFileSync(specFile(), "utf8").replace("Текст раздела model.", "Текст раздела model, переписан."),
    );

  it("records the fingerprint of what was shown", () => {
    expect(take().code).toBe(0);
    expect(saved().spec_seen).toHaveLength(1);
    expect(saved().spec_seen[0]).toMatchObject({ address: "tasks#model" });
    expect(saved().spec_seen[0].hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("refuses `updated` when the section is byte-for-byte what was shown", () => {
    take();
    const { code, out } = cliRun("spec", "answer", "1", "updated", "--text", NOTE);
    expect(code).not.toBe(0);
    expect(out).toMatch(/байт в байт тот же текст/);
    expect(saved().spec_answers).toBeUndefined();
  });

  it("accepts `updated` once the section really moved", () => {
    take();
    edit();
    const { code } = cliRun("spec", "answer", "1", "updated", "--text", NOTE);
    expect(code).toBe(0);
    expect(saved().spec_answers[0].verdict).toBe("updated");
  });

  it("`unchanged` stays legal on an untouched section — that is what it means", () => {
    take();
    expect(cliRun("spec", "answer", "1", "unchanged", "--text", NOTE).code).toBe(0);
  });

  it("says so out loud when there is no baseline to check against", () => {
    // The task never passed the injection anchor, so nothing was fingerprinted.
    const { code, out } = cliRun("spec", "answer", "1", "updated", "--text", NOTE);
    expect(code).toBe(0);
    expect(out).toMatch(/подтвердить нечем/);
  });

  it("a reflow of the same sentences is not an edit", () => {
    take();
    writeFileSync(
      specFile(),
      readFileSync(specFile(), "utf8").replace("Текст раздела model.", "Текст   раздела\nmodel."),
    );
    expect(cliRun("spec", "answer", "1", "updated", "--text", NOTE).code).not.toBe(0);
  });
});

describe("attributing a single bullet to the task that wrote it (t#353)", () => {
  let dir;
  let boardFile;
  const NOTE = "раздел дополнен новым пунктом про порядок закрытия, остальное не трогал";
  const specFile = () => path.join(dir, "docs", "specs", "tasks", "spec.md");

  const cliRun = (area, ...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, area, ...args], {
          encoding: "utf8",
          cwd: dir,
          env: { ...process.env, APPDATA: dir },
          windowsHide: true,
        }),
      };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };
  const saved = () => JSON.parse(readFileSync(boardFile, "utf8")).todos[0];

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-blocks-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    boardFile = path.join(dir, "com.claude-usage-tracker.app", "todos.json");
    writeDomain(
      path.join(dir, "docs", "specs"),
      "tasks",
      ["id: tasks", "version: 1"].join("\n"),
      [
        "## model — Модель",
        "",
        "part: устройство",
        "",
        "- Первый пункт, он же самый старый.",
        "- Второй пункт с продолжением,",
        "  которое идёт с отступом.",
        "- Третий пункт.",
      ].join("\n"),
    );
    writeFileSync(
      boardFile,
      JSON.stringify(
        {
          version: 1,
          todos: [{ id: "t1", number: 7, subject: "узел", status: "queue", spec: ["tasks#model"] }],
        },
        null,
        2,
      ),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("splits a section into top-level bullets, continuation lines included", () => {
    const blocks = sectionBlocks([
      "- Первый.",
      "- Второй,",
      "  с продолжением.",
      "",
      "Абзац.",
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[1].text).toBe("- Второй,\n  с продолжением.");
    expect(blocks.every((b) => /^[0-9a-f]{12}$/.test(b.hash))).toBe(true);
  });

  it("records only the bullets the task actually moved", () => {
    expect(cliRun("todos", "set", "status", "7", "in_progress").code).toBe(0);
    expect(saved().spec_seen[0].blocks).toHaveLength(3);

    // One bullet edited, one added, one left alone.
    writeFileSync(
      specFile(),
      readFileSync(specFile(), "utf8")
        .replace("- Третий пункт.", "- Третий пункт, переписанный.\n- Четвёртый, новый.")
    );
    expect(cliRun("spec", "answer", "7", "updated", "--text", NOTE).code).toBe(0);

    const answer = saved().spec_answers[0];
    const blocks = sectionBlocks(
      readFileSync(specFile(), "utf8").split("part: устройство")[1].trim().split("\n"),
    );
    const owned = blocks.filter((b) => answer.blocks.includes(b.hash)).map((b) => b.text);
    expect(owned).toEqual(["- Третий пункт, переписанный.", "- Четвёртый, новый."]);
    // The untouched bullets stay unattributed — that is the whole point.
    expect(answer.blocks).toHaveLength(2);
  });

  it("an edit by a LATER task takes the mark off the earlier one", () => {
    // The hash is the identity, so re-writing a bullet drops its old mark by
    // itself — no bookkeeping, no stale attribution.
    cliRun("todos", "set", "status", "7", "in_progress");
    writeFileSync(
      specFile(),
      readFileSync(specFile(), "utf8").replace("- Третий пункт.", "- Третий пункт, версия один."),
    );
    cliRun("spec", "answer", "7", "updated", "--text", NOTE);
    const first = saved().spec_answers[0].blocks[0];

    writeFileSync(
      specFile(),
      readFileSync(specFile(), "utf8").replace(
        "- Третий пункт, версия один.",
        "- Третий пункт, версия два.",
      ),
    );
    const now = sectionBlocks(
      readFileSync(specFile(), "utf8").split("part: устройство")[1].trim().split("\n"),
    ).map((b) => b.hash);
    expect(now).not.toContain(first);
  });

  it("no baseline to diff against → no marks, rather than made-up ones", () => {
    // The task never passed the injection anchor: nothing was fingerprinted, so
    // there is nothing honest to attribute.
    writeFileSync(
      specFile(),
      readFileSync(specFile(), "utf8").replace("- Третий пункт.", "- Третий пункт, переписанный."),
    );
    expect(cliRun("spec", "answer", "7", "updated", "--text", NOTE).code).toBe(0);
    expect(saved().spec_answers[0].blocks).toBeUndefined();
  });
});

// --- the planning-time advisor (t#342) --------------------------------------
//
// What is held down here is not the ranking (a lexical score has no right
// answer to assert) but the three ANSWERS the command owes its reader: these
// sections, this one is already linked, and — the one it exists for — there is
// no section for this.

describe("cli spec match — есть ли под этот текст раздел (t#342)", () => {
  let dir;

  const MATCH_FM = (id) => [`id: ${id}`, "version: 1", "updated: 2026-08-03"].join("\n");

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-match-"));
    writeDomain(
      dir,
      "tasks",
      MATCH_FM("tasks"),
      [
        "# tasks",
        "",
        "## model — Модель и хранение",
        "",
        "part: устройство",
        "",
        "Задача — узел направленного ациклического графа. Доски разделены по проектам,",
        "хранилище — один файл на доску, запись атомарна.",
        "",
        "## done-gate — Инварианты закрытия",
        "",
        "part: инварианты",
        "",
        "Перевод в done отклоняется, пока не закрыт хотя бы один прямой prerequisite;",
        "отказ перечисляет блокирующие задачи по номеру.",
        "",
      ].join("\n"),
    );
    writeDomain(
      dir,
      "usage-tracker",
      MATCH_FM("usage-tracker"),
      [
        "# usage-tracker",
        "",
        "## forecast — Форекаст и бюджет",
        "",
        "part: требования",
        "",
        "Форекаст считает темп сжигания лимита и говорит, на сколько хватит бюджета",
        "до сброса окна.",
        "",
      ].join("\n"),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("находит раздел по лексике и говорит, ЧТО совпало", () => {
    const res = matchSections("пересчитать темп сжигания лимита и бюджет до сброса", { root: dir });
    expect(res.zero).toBe(false);
    expect(res.matches[0].address).toBe("usage-tracker#forecast");
    expect(res.matches[0].score).toBeGreaterThanOrEqual(res.min);
    // The reader has to be able to see WHY, not just a number.
    expect([...res.matches[0].heading_hits, ...res.matches[0].prose_hits]).toEqual(
      expect.arrayContaining(["темп", "лимита"]),
    );
  });

  it("честный ноль: под текст из другой области раздела НЕТ, и лучший из мусора не выдаётся", () => {
    const res = matchSections("подсветка синтаксиса кириллических шрифтов в редакторе писем", {
      root: dir,
    });
    expect(res.zero).toBe(true);
    expect(res.matches).toEqual([]);
    expect(res.reason).toMatch(/раздела под это нет/);
    // The near miss is named as a miss — hiding it would send the reader to
    // `spec domains` to reconstruct the same answer by hand.
    expect(res.near === null || res.near.score < res.min).toBe(true);
  });

  it("уже слинкованный раздел помечен как сверка, а не подан как находка", () => {
    const linked = ["usage-tracker#forecast"];
    const res = matchSections("темп сжигания лимита и бюджет", { root: dir, linked });
    const hit = res.matches.find((m) => m.address === "usage-tracker#forecast");
    expect(hit.linked).toBe(true);
    expect(res.matches.filter((m) => !m.linked).map((m) => m.address)).not.toContain(
      "usage-tracker#forecast",
    );
  });

  it("«нельзя судить» — не то же самое, что «раздела нет»", () => {
    const res = matchSections("форекаст", { root: dir });
    expect(res.zero).toBe(true);
    expect(res.undecided).toBe(true);
    expect(res.reason).toMatch(/меньше двух значимых слов/);
  });

  it("адрес, названный в тексте, проходит мимо порога — это не догадка", () => {
    const res = matchSections("правим tasks#done-gate под совершенно посторонний предмет", {
      root: dir,
    });
    const hit = res.matches.find((m) => m.address === "tasks#done-gate");
    expect(hit).toBeTruthy();
    expect(hit.named).toBe(true);
    expect(res.named).toEqual(["tasks#done-gate"]);
  });

  it("несуществующий адрес в тексте не превращается в кандидата", () => {
    expect(addressesIn("смотри tasks#no-such и other#gone", dir)).toEqual([]);
  });

  it("падежи сводятся к одной основе, ASCII-идентификаторы — нет", () => {
    expect(stem("задачи")).toBe(stem("задача"));
    expect(stem("разделов")).toBe(stem("раздел"));
    expect(stem("hooks")).toBe("hook");
    expect(stem("status")).toBe("status");
  });

  it("порог обсуждаемый: --min пропускает то, что при штатном пороге ушло в ноль", () => {
    const text = "подсветка синтаксиса кириллических шрифтов в редакторе писем";
    expect(matchSections(text, { root: dir }).zero).toBe(true);
    expect(matchSections(text, { root: dir, min: 0 }).matches.length).toBeGreaterThan(0);
  });
});

describe("cli spec match — command wiring (t#342)", () => {
  let dir;
  let boardFile;

  const run = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, "spec", "match", ...args], {
          encoding: "utf8",
          cwd: dir,
          env: { ...process.env, APPDATA: dir },
          windowsHide: true,
        }),
      };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-match-cli-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    boardFile = path.join(dir, "com.claude-usage-tracker.app", "todos.json");
    writeDomain(
      path.join(dir, "docs", "specs"),
      "usage-tracker",
      ["id: usage-tracker", "version: 1"].join("\n"),
      [
        "## forecast — Форекаст и бюджет",
        "",
        "part: требования",
        "",
        "Форекаст считает темп сжигания лимита и говорит, на сколько хватит бюджета.",
      ].join("\n"),
    );
    writeDomain(
      path.join(dir, "docs", "specs"),
      "tasks",
      ["id: tasks", "version: 1"].join("\n"),
      [
        "## model — Модель и хранение",
        "",
        "part: устройство",
        "",
        "Задача — узел графа, доски разделены по проектам.",
      ].join("\n"),
    );
    writeFileSync(
      boardFile,
      JSON.stringify(
        {
          version: 1,
          todos: [
            {
              id: "t1",
              number: 1,
              subject: "Пересчитать темп сжигания лимита",
              status: "queue",
              spec: ["usage-tracker#forecast"],
            },
          ],
        },
        null,
        2,
      ),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("печатает адрес, счёт и что делать дальше", () => {
    const { code, out } = run("темп сжигания лимита и бюджет");
    expect(code).toBe(0);
    expect(out).toMatch(/usage-tracker#forecast/);
    expect(out).toMatch(/cli spec show usage-tracker#forecast/);
  });

  it("«раздела под это нет» — тоже успешный ответ, а не ошибка и не молчание", () => {
    const { code, out } = run("подсветка синтаксиса кириллических шрифтов в редакторе писем");
    expect(code).toBe(0);
    expect(out).toMatch(/раздела под это нет/);
    expect(out).toMatch(/повод завести раздел/);
    expect(out).not.toMatch(/cli todos set spec/);
  });

  it("--task берёт текст с доски и не подаёт слинкованный раздел как находку", () => {
    const { code, out } = run("--task", "1");
    expect(code).toBe(0);
    expect(out).toMatch(/уже слинковано: usage-tracker#forecast/);
    expect(out).toMatch(/УЖЕ СЛИНКОВАН/);
  });

  it("--json отдаёт машинный ответ с порогом и разбором совпадений", () => {
    const r = JSON.parse(run("темп сжигания лимита", "--json").out);
    expect(r.ok).toBe(true);
    expect(r.min).toBeGreaterThan(0);
    expect(r.matches[0].address).toBe("usage-tracker#forecast");
    expect(r.zero).toBe(false);
  });

  it("ничего не пишет на доску — советник, а не запись", () => {
    const before = readFileSync(boardFile, "utf8");
    run("--task", "1");
    expect(readFileSync(boardFile, "utf8")).toBe(before);
  });
});

// The addressable unit inside a section (t#358): a link that can only name a
// section makes every question about it a question about the whole thing.
describe("anchors — the addressable unit inside a section", () => {
  let dir;
  const ANCHORED = [
    "## registry — Реестр",
    "",
    "part: устройство",
    "",
    "Вводная строка, которая ни к одному якорю не относится.",
    "",
    "### address — Адресация",
    "",
    "- Адрес раздела — `<домен>#<слаг>`.",
    "- Якорь добавляет третью часть.",
    "",
    "### lint — Проверки",
    "",
    "- Дубль слага отклоняется.",
    "",
  ].join("\n");

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-spec-anchor-"));
    writeDomain(dir, "tasks", HAPPY_TASKS_FM, ANCHORED);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("splits a section into units and keeps the lead-in outside them", () => {
    const anchors = loadDomain("tasks", dir).headings.get("registry").anchors;
    expect(anchors.map((a) => a.slug)).toEqual(["address", "lint"]);
    expect(anchors[0].title).toBe("Адресация");
    expect(anchors[0].prose).toEqual([
      "- Адрес раздела — `<домен>#<слаг>`.",
      "- Якорь добавляет третью часть.",
    ]);
    expect(anchors.lead).toEqual(["Вводная строка, которая ни к одному якорю не относится."]);
  });

  it("a section with no anchors keeps its whole prose as the lead-in", () => {
    writeDomain(dir, "plain", ["id: plain", "version: 1"].join("\n"), [
      "## one — Один",
      "",
      "part: устройство",
      "",
      "Сплошная проза, никаких якорей.",
    ].join("\n"));
    const h = loadDomain("plain", dir).headings.get("one");
    expect(h.anchors).toHaveLength(0);
    expect(h.anchors.lead).toEqual(["Сплошная проза, никаких якорей."]);
  });

  it("resolves an anchored address and names the known anchors when it cannot", () => {
    expect(resolveAddress("tasks#registry/lint", dir).ok).toBe(true);
    const bad = resolveAddress("tasks#registry/nope", dir);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("address, lint");
  });

  it("show answers about the UNIT, not the section it sits in", () => {
    const s = showSection("tasks#registry/lint", dir);
    expect(s.anchor).toBe("lint");
    expect(s.text).toBe("### lint — Проверки\n\n- Дубль слага отклоняется.");
    expect(s.text).not.toContain("Адресация");
    // The section's own title travels along: a unit read out of its section
    // reads as an orphan.
    expect(s.entry).toMatchObject({ title: "Проверки", section: "Реестр", part: "устройство" });
    expect(s.anchors.map((a) => a.slug)).toEqual(["address", "lint"]);
    expect(s.blocks).toHaveLength(1);
  });

  it("the baseline and the blocks are scoped to the unit", () => {
    const whole = sectionFingerprint("tasks#registry", dir);
    const unit = sectionFingerprint("tasks#registry/address", dir);
    expect(unit).not.toBe(whole);
    expect(blocksOf("tasks#registry/address", dir)).toHaveLength(2);
    expect(blocksOf("tasks#registry", dir).length).toBeGreaterThan(2);
  });

  it("a duplicated anchor is refused the same way a duplicated slug is", () => {
    writeDomain(dir, "tasks", HAPPY_TASKS_FM, ANCHORED + "\n### lint — Ещё раз\n\n- Второй.\n");
    const dup = validateRegistry(dir, dir).filter((f) => f.rule === "duplicate-anchor");
    expect(dup).toHaveLength(1);
    expect(dup[0].severity).toBe("error");
    expect(dup[0].message).toContain("lint");
  });

  it("a ref into a missing anchor dangles, and one into a real anchor does not", () => {
    const withRef = (ref) =>
      writeDomain(
        dir,
        "tasks",
        HAPPY_TASKS_FM,
        ANCHORED.replace("part: устройство", `part: устройство\nrefs: ${ref}`),
      );
    withRef("tasks#registry/lint");
    expect(validateRegistry(dir, dir).filter((f) => f.rule === "dangling-ref")).toEqual([]);
    withRef("tasks#registry/gone");
    const found = validateRegistry(dir, dir).filter((f) => f.rule === "dangling-ref");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('нет якоря "gone"');
  });

  it("the line ceiling stays a SECTION budget, not a per-anchor one", () => {
    const long = [
      "## big — Большой",
      "",
      "part: устройство",
      "",
      ...Array.from({ length: 40 }, (_, i) => `### a${i} — Якорь ${i}\n\n- строка\n- строка\n`),
    ].join("\n");
    writeDomain(dir, "tasks", HAPPY_TASKS_FM, long);
    const found = validateRegistry(dir, dir).filter((f) => f.rule === "section-too-long");
    expect(found).toHaveLength(1);
    expect(found[0].address).toBe("tasks#big");
  });

  it("match scores the units, not the container they sit in", () => {
    const corpus = buildCorpus(dir);
    expect(corpus.map((s) => s.address)).toEqual(["tasks#registry/address", "tasks#registry/lint"]);
    const res = matchSections("дубль слага отклоняется проверкой", { root: dir, min: 0 });
    expect(res.matches[0].address).toBe("tasks#registry/lint");
  });
});
