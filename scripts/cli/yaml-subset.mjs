// Shared YAML subset for the tracker's hand-parsed files (t#314, t#339): the
// process-graph documents `todos apply` reads and the frontmatter of spec.md
// files. Deliberately a subset, not a YAML implementation: the CLI ships into
// the Tauri bundle without node_modules, so a parser is written or nothing is.
// What it takes: nested mappings by indentation, `key: value`, block scalars
// (| and >), inline lists `[a, b]`, block lists of scalars and of objects,
// quoted values. What it does NOT take: anchors, multi-document files, flow
// mappings, and trailing `# comments` (a whole-line comment is fine — `t#299`
// inside a value must survive, and that is worth more than end-of-line
// comments).

const dequote = (s) => {
  const v = s.trim();
  if (v.length > 1 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")))
    return v.slice(1, -1);
  return v;
};

const inlineList = (s) =>
  s
    .slice(1, -1)
    .split(",")
    .map((x) => dequote(x))
    .filter((x) => x !== "");

function scalar(raw) {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) return inlineList(v);
  return dequote(v);
}

const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => !line.trim() || line.trimStart().startsWith("#");

function parseBlock(lines, i, indent) {
  while (i < lines.length && isBlank(lines[i])) i++;
  if (i >= lines.length) return [null, i];
  if (lines[i].trimStart().startsWith("- ") || lines[i].trim() === "-")
    return parseList(lines, i, indentOf(lines[i]));
  return parseMap(lines, i, indent);
}

function parseList(lines, i, indent) {
  const out = [];
  while (i < lines.length) {
    if (isBlank(lines[i])) {
      i++;
      continue;
    }
    const ind = indentOf(lines[i]);
    if (ind < indent) break;
    const body = lines[i].trim();
    if (!body.startsWith("-")) break;
    const rest = body.slice(1).trim();
    if (/^[^:\s][^:]*:/.test(rest)) {
      const keyIndent = lines[i].indexOf(rest, ind);
      const rebuilt = [" ".repeat(keyIndent) + rest, ...lines.slice(i + 1)];
      const [value, consumed] = parseMap(rebuilt, 0, keyIndent);
      out.push(value);
      i = i + consumed;
      continue;
    }
    if (rest) {
      out.push(scalar(rest));
      i++;
      continue;
    }
    const [value, next] = parseBlock(lines, i + 1, ind + 1);
    out.push(value);
    i = next;
  }
  return [out, i];
}

function parseMap(lines, i, indent) {
  const out = {};
  while (i < lines.length) {
    if (isBlank(lines[i])) {
      i++;
      continue;
    }
    const ind = indentOf(lines[i]);
    if (ind < indent) break;
    const line = lines[i].trim();
    const m = line.match(/^([^:]+):(.*)$/);
    if (!m) break;
    const key = dequote(m[1]);
    const rest = m[2].trim();
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      const [text, next] = parseTextBlock(lines, i + 1, ind, rest[0] === ">");
      out[key] = text;
      i = next;
      continue;
    }
    if (rest) {
      out[key] = scalar(rest);
      i++;
      continue;
    }
    const [value, next] = parseBlock(lines, i + 1, ind + 1);
    out[key] = value === null ? "" : value;
    i = next;
  }
  return [out, i];
}

function parseTextBlock(lines, i, indent, fold) {
  const body = [];
  while (i < lines.length) {
    if (!lines[i].trim()) {
      body.push("");
      i++;
      continue;
    }
    if (indentOf(lines[i]) <= indent) break;
    body.push(lines[i].trimEnd());
    i++;
  }
  while (body.length && !body.at(-1)) body.pop();
  const strip = body.reduce((min, l) => (l.trim() ? Math.min(min, indentOf(l)) : min), Infinity);
  const text = body.map((l) => (l.trim() ? l.slice(strip) : ""));
  return [fold ? text.join(" ").replace(/\s+/g, " ").trim() : text.join("\n"), i];
}

export function parseYamlSubset(text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const [value] = parseBlock(lines, 0, 0);
  return value && typeof value === "object" ? value : {};
}
