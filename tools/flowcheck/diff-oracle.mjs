#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, rmSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/(.:\/)/, '$1'));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args.at(at + 1);
};
if (args.includes('--help')) {
  console.log('Usage: node tools/flowcheck/diff-oracle.mjs [--pilot PATH] [--python PATH] [--rust PATH] [--live-repo PATH --live-cases FILE]');
  process.exit(0);
}
const pilotPath = option('--pilot', process.env.FLOWCHECK_PILOT);
if (!pilotPath) {
  console.error('Set FLOWCHECK_PILOT or pass --pilot with the Python pilot directory.');
  process.exit(2);
}
const pilot = resolve(pilotPath);
const python = resolve(option('--python', process.env.FLOWCHECK_PYTHON ?? join(pilot, 'gv/Scripts/python.exe')));
const liveRepo = option('--live-repo', process.env.FLOWCHECK_LIVE_REPO);
const liveCases = option('--live-cases', process.env.FLOWCHECK_LIVE_CASES);
let rust = option('--rust', process.env.FLOWCHECK_RUST);

function run(command, commandArgs, options = {}) {
  const child = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  if (child.error) throw new Error(`${command}: ${child.error.message}`);
  return child;
}
function json(command, commandArgs, options) {
  const result = run(command, commandArgs, options);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${command} emitted non-JSON:\n${result.stdout}\n${result.stderr}`); }
}
function reasonSet(row) { return new Set(row.problems ?? []); }
function sameSet(left, right) {
  return left.size === right.size && [...left].every(value => right.has(value));
}
function compare(label, pyRows, rustRows) {
  const errors = [];
  if (pyRows.length === 0) return [`${label}: Python returned no results`];
  if (pyRows.length !== rustRows.length) {
    return [`${label}: result count: Python=${pyRows.length}, Rust=${rustRows.length}`];
  }
  pyRows.forEach((py, index) => {
    const rs = rustRows[index];
    const name = `${label} [${index + 1}] ${py.method ?? '<unknown>'}`;
    if (py.method !== rs.method) errors.push(`${name}: method: Python=${py.method}, Rust=${rs.method}`);
    if (py.status !== rs.status) errors.push(`${name}: status: Python=${py.status}, Rust=${rs.status}`);
    if (!sameSet(reasonSet(py), reasonSet(rs))) {
      errors.push(`${name}: reasons differ\n  Python: ${JSON.stringify([...reasonSet(py)].sort())}\n  Rust:   ${JSON.stringify([...reasonSet(rs)].sort())}`);
    }
  });
  return errors;
}
function checkCase(label, spec, repo, base, head) {
  const pyRows = json(python, [join(pilot, 'flowcheck.py'), spec, '--repo', repo, '--base', base, '--head', head]);
  const rustOutput = json(rust, ['--spec', spec, '--repo', repo, '--base', base, '--head', head]);
  return compare(label, pyRows, rustOutput.results ?? []);
}
function git(repo, gitArgs) {
  const result = run('git', ['-C', repo, ...gitArgs]);
  return result.status === 0;
}

if (!rust) {
  const built = run('cargo', ['build', '--quiet'], { cwd: here });
  if (built.status !== 0) throw new Error(`cargo build failed:\n${built.stderr}`);
  rust = join(here, 'target', 'debug', process.platform === 'win32' ? 'flowcheck.exe' : 'flowcheck');
}
rust = resolve(rust);

const temporary = mkdtempSync(join(tmpdir(), 'flowcheck-oracle-'));
const failures = [];
let checked = 0;
let skipped = 0;
try {
  const source = join(here, 'tests', 'fixture');
  const spec = join(temporary, 'phone.yaml');
  writeFileSync(spec, readFileSync(join(pilot, 'spec-phone.yaml')));
  const fixtures = readdirSync(source)
    .filter(file => /^Notifier\..+\.cs$/.test(file) && file !== 'Notifier.base.cs')
    .sort();
  for (const fixture of fixtures) {
    const repo = join(temporary, basename(fixture, '.cs'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    cpSync(join(source, 'Contracts.cs'), join(repo, 'src', 'Contracts.cs'));
    cpSync(join(source, 'Notifier.base.cs'), join(repo, 'src', 'Notifier.cs'));
    run('git', ['init', '-q'], { cwd: repo });
    run('git', ['add', '.'], { cwd: repo });
    run('git', ['-c', 'user.name=oracle', '-c', 'user.email=oracle@example.invalid', 'commit', '-qm', 'base'], { cwd: repo });
    const base = run('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
    cpSync(join(source, fixture), join(repo, 'src', 'Notifier.cs'));
    failures.push(...checkCase(`fixture/${fixture}`, spec, repo, base, 'HEAD'));
    checked += 1;
  }

  const live = liveCases ? JSON.parse(readFileSync(resolve(liveCases), 'utf8')).map(c => [c.label, c.spec, c.base, c.head]) : [];
  if (!liveRepo || !live.length) {
    skipped = live.length;
    console.log(`Live cases skipped: ${skipped} (set FLOWCHECK_LIVE_REPO and FLOWCHECK_LIVE_CASES).`);
  } else {
    const repo = resolve(liveRepo);
    for (const [label, specFile, base, head] of live) {
      if (!git(repo, ['rev-parse', '--verify', `${base}^{commit}`]) || !git(repo, ['rev-parse', '--verify', `${head}^{commit}`])) {
        console.log(`SKIP ${label}: required commit is absent from ${repo}`);
        skipped += 1;
        continue;
      }
      failures.push(...checkCase(label, resolve(pilot, specFile), repo, base, head));
      checked += 1;
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log(`Compared ${checked} case(s); skipped ${skipped} live case(s).`);
if (failures.length) {
  console.error(`Differential mismatches (${failures.length}):\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Rust and Python agree on every compared method status and reason set.');
}
