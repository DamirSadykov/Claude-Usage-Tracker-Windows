import { showSection, sectionFingerprint, blocksOf } from "./spec.mjs";

function formatSpecSection(address, opts = {}) {
  const res = showSection(address, opts.root, opts.appData);
  if (!res.ok) return `— ${address}: ${res.reason}`;
  if (res.remote && !res.available) {
    return `— ${address}: ${res.unavailable}` + (res.stub?.trim() ? `\n\n${res.stub.trim()}` : "");
  }
  return res.text?.trim() || `— ${address}: (empty section)`;
}

export function formatSpecSections(t, spec, opts = {}) {
  const { source, addresses } = spec;
  if (!addresses.length) return "";
  const who = source === "task"
    ? `#${t.number} "${t.subject}"'s own \`spec\` field`
    : `the \`spec\` field of #${t.number} "${t.subject}"'s change root(s)`;
  return `📘 Spec section(s) addressed by ${who} — read in FULL before touching this area:\n\n` +
    addresses.map((address) => formatSpecSection(address, opts)).join("\n\n") +
    "\n\n(any `refs:` line above names OTHER sections by address only — pull one's own text only if you actually need it, not preemptively)\n";
}

export function recordSpecBaseline(t, addresses, opts = {}) {
  if (!Array.isArray(addresses) || !addresses.length) return;
  const at = new Date().toISOString();
  const seen = Array.isArray(t.spec_seen) ? t.spec_seen.slice() : [];
  for (const address of addresses) {
    const hash = sectionFingerprint(address, opts.root);
    if (!hash) continue;
    const blocks = blocksOf(address, opts.root);
    const entry = { address, hash, blocks: blocks.map((b) => b.hash), text: blocks.map((b) => b.text).join("\n"), at };
    const i = seen.findIndex((x) => x && x.address === address);
    if (i >= 0) seen[i] = entry;
    else seen.push(entry);
  }
  if (seen.length) t.spec_seen = seen;
}
