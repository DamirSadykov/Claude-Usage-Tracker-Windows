#!/usr/bin/env node
// Bumps the app version in all files where it is duplicated:
//   package.json, package-lock.json, src-tauri/Cargo.toml,
//   src-tauri/Cargo.lock, src-tauri/tauri.conf.json
// Usage: npm run bump <patch|minor|major|X.Y.Z>

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...segs) => path.join(root, ...segs);

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run bump <patch|minor|major|X.Y.Z>');
  process.exit(1);
}

const pkgPath = p('package.json');
const current = JSON.parse(readFileSync(pkgPath, 'utf8')).version;

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else {
  const [major, minor, patch] = current.split('.').map(Number);
  if (arg === 'major') next = `${major + 1}.0.0`;
  else if (arg === 'minor') next = `${major}.${minor + 1}.0`;
  else if (arg === 'patch') next = `${major}.${minor}.${patch + 1}`;
  else {
    console.error(`Unknown argument "${arg}". Expected patch, minor, major or X.Y.Z`);
    process.exit(1);
  }
}

if (next === current) {
  console.error(`Version is already ${current}, nothing to do`);
  process.exit(1);
}

// Each entry replaces an exact pattern and must match exactly once.
// All files are validated before anything is written, so a failure
// in one file leaves the repo untouched.
const replacements = [
  {
    file: pkgPath,
    pattern: `"version": "${current}"`,
    replace: `"version": "${next}"`,
  },
  {
    file: p('src-tauri', 'tauri.conf.json'),
    pattern: `"version": "${current}"`,
    replace: `"version": "${next}"`,
  },
  {
    file: p('src-tauri', 'Cargo.toml'),
    pattern: new RegExp(`^version = "${current.replaceAll('.', '\\.')}"$`, 'm'),
    replace: `version = "${next}"`,
  },
  {
    file: p('src-tauri', 'Cargo.lock'),
    pattern: /(\[\[package\]\]\r?\nname = "claude-usage-tracker"\r?\nversion = ")[^"]+(")/,
    replace: `$1${next}$2`,
  },
];

const pending = replacements.map(({ file, pattern, replace }) => {
  const text = readFileSync(file, 'utf8');
  const matches = typeof pattern === 'string'
    ? text.split(pattern).length - 1
    : (text.match(new RegExp(pattern, pattern.flags + 'g')) ?? []).length;
  if (matches !== 1) {
    console.error(`${path.relative(root, file)}: expected exactly 1 match for version pattern, found ${matches}`);
    process.exit(1);
  }
  return { file, text: text.replace(pattern, replace) };
});

// package-lock.json: the version can lag behind package.json after manual
// bumps, so it is set to `next` via JSON rather than matched against `current`.
const lockPath = p('package-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
lock.version = next;
lock.packages[''].version = next;
pending.push({ file: lockPath, text: JSON.stringify(lock, null, 2) + '\n' });

for (const { file, text } of pending) {
  writeFileSync(file, text);
  console.log(`  ${path.relative(root, file)}`);
}
console.log(`${current} -> ${next}`);
