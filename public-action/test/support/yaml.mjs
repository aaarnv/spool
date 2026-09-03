// A YAML reader for exactly one job: linting this action's own action.yml. It covers
// the subset GitHub action metadata uses and throws on anything outside it.

const BLOCK = /^([|>])([-+]?)$/;

function scan(text) {
  const out = [];
  const raw = text.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].replace(/\t/g, "  ");
    if (!line.trim()) {
      out.push({ indent: null, content: "", blank: true, n: i + 1 });
      continue;
    }
    // Comments stay in the stream: one inside a `run: |` block is shell, not YAML.
    out.push({
      indent: line.match(/^ */)[0].length,
      content: line.trim(),
      blank: false,
      comment: /^\s*#/.test(line),
      n: i + 1,
    });
  }
  return out;
}

// Only outside quotes, and only when the # opens a word, so "a#b" and '#{' survive.
function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}

function scalar(raw) {
  const s = stripComment(raw).trim();
  if (s === "") return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function body(lines, from, indent) {
  const out = [];
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (line.blank) {
      out.push(line);
      continue;
    }
    if (line.indent <= indent) {
      // A comment outdented past the body ends nothing; it just is not part of it.
      if (line.comment) continue;
      break;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1].blank) out.pop();
  return out;
}

function block(lines, style, chomp) {
  if (!lines.length) return "";
  const first = lines.find((l) => !l.blank && !l.comment) ?? lines.find((l) => !l.blank);
  const base = first.indent;
  const rows = lines.map((l) => (l.blank ? "" : " ".repeat(Math.max(0, l.indent - base)) + l.content));
  if (style === "|") return chomp === "-" ? rows.join("\n") : `${rows.join("\n")}\n`;
  // Folded: blank lines become paragraph breaks, everything else joins with a space.
  const folded = rows
    .join("\n")
    .split(/\n{2,}/)
    .map((p) => p.split("\n").join(" ").trim())
    .join("\n");
  return chomp === "-" ? folded : `${folded}\n`;
}

function parse(lines) {
  const first = lines.find((l) => !l.blank && !l.comment);
  if (!first) return null;
  return first.content.startsWith("- ") || first.content === "-" ? sequence(lines) : mapping(lines);
}

function sequence(lines) {
  const indent = lines.find((l) => !l.blank && !l.comment).indent;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.blank || line.comment || line.indent > indent) continue;
    if (!line.content.startsWith("-")) throw new Error(`line ${line.n}: expected a sequence item`);
    const head = line.content.replace(/^-\s*/, "");
    const rest = body(lines, i + 1, indent);
    if (!head) {
      out.push(parse(rest));
      continue;
    }
    // Re-indent the inline head so it parses as the item's first mapping key.
    out.push(parse([{ indent: indent + 2, content: head, blank: false, n: line.n }, ...rest]));
  }
  return out;
}

function mapping(lines) {
  const indent = lines.find((l) => !l.blank && !l.comment).indent;
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.blank || line.comment || line.indent > indent) continue;
    const m = line.content.match(/^([^:]+):(?:\s+(.*))?$/);
    if (!m) throw new Error(`line ${line.n}: expected "key: value"`);
    const key = m[1].trim().replace(/^["']|["']$/g, "");
    const rest = (m[2] ?? "").trim();
    const child = body(lines, i + 1, indent);
    const b = rest.match(BLOCK);
    if (b) out[key] = block(child, b[1], b[2]);
    else if (rest === "") out[key] = child.length ? parse(child) : null;
    else out[key] = scalar(rest);
  }
  return out;
}

export function parseActionYml(text) {
  const parsed = parse(scan(text));
  if (!parsed || typeof parsed !== "object") throw new Error("action.yml did not parse as a mapping");
  return parsed;
}
