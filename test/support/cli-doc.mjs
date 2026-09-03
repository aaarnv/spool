// Documentation an agent executes, checked against the CLI itself.
//
// A command a document names that commander does not have is a broken tool call in
// somebody else's session. This module resolves every `spool …` invocation in a markdown
// file against `--help`, command by command and flag by flag, so a renamed flag fails a
// test instead of failing an agent. Used by test/skill-doc.test.mjs (the agent skill) and
// test/pilot-doc.test.mjs (the pilot runbook and the dispatch preset).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const repo = join(dirname(dirname(fileURLToPath(import.meta.url))), '..');
const cli = join(repo, 'bin', 'spool.mjs');

/**
 * One command's own options and children, read from `spool <path> --help`.
 *
 * Commander wraps long help lines, and every wrapped line is indented past the column the
 * name starts in. Anchoring on exactly two spaces therefore reads names only, never the
 * description text that mentions other flags.
 */
export async function helpOf(path) {
  const { stdout } = await exec(process.execPath, [cli, ...path, '--help'], { cwd: repo });
  const options = new Set(['-h', '--help']);
  const commands = new Map(); // name or alias -> canonical name
  let section = null;
  for (const line of stdout.split('\n')) {
    if (/^Options:/.test(line)) { section = 'options'; continue; }
    if (/^Commands:/.test(line)) { section = 'commands'; continue; }
    if (/^\S/.test(line)) { section = null; continue; }
    const entry = line.match(/^ {2}(\S+.*)$/);
    if (!entry || !section) continue;
    if (section === 'options') {
      for (const flag of entry[1].split(/\s{2,}/)[0].split(/,\s*/)) {
        const name = flag.trim().split(/[ <[]/)[0];
        if (name.startsWith('-')) options.add(name);
      }
    } else {
      const names = entry[1].split(/\s+/)[0];
      if (names.startsWith('-')) continue;
      const [canonical, ...aliases] = names.split('|');
      for (const name of [canonical, ...aliases]) commands.set(name, canonical);
    }
  }
  return { options, commands };
}

/** The whole command tree, keyed by the space-joined path an invocation spells out. */
export async function commandTree() {
  const tree = new Map();
  const walk = async (path) => {
    const node = await helpOf(path);
    tree.set(path.join(' '), node);
    for (const [alias, canonical] of node.commands) {
      if (alias !== canonical || canonical === 'help') continue;
      await walk([...path, canonical]);
    }
  };
  await walk([]);
  return tree;
}

/** Split a shell-ish line into tokens, keeping quoted strings whole. */
export function tokenize(line) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { current += line[++i]; continue; }
    if (quote) {
      if (c === quote) quote = null;
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (/\s/.test(c)) { if (current) { tokens.push(current); current = ''; } continue; }
    current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Every `spool …` invocation in a markdown file: the fenced blocks an agent copies, and
 * the inline spans it reads as instructions. Both ship to a cold agent, so both are checked.
 */
export function invocations(markdown) {
  const found = [];
  const push = (text, line) => {
    const command = text.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '').trim();
    if (/^spool(\s|$)/.test(command)) found.push({ command, line });
  };

  const lines = markdown.split('\n');
  let fenced = false;
  let pending = null;
  lines.forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { fenced = !fenced; pending = null; return; }
    if (fenced) {
      const text = raw.trim();
      if (pending !== null) {
        pending.text += ' ' + text.replace(/\\$/, '').trim();
        if (!/\\$/.test(text)) { push(pending.text, pending.line); pending = null; }
        return;
      }
      if (text.startsWith('#') || !text) return;
      if (/\\$/.test(text)) { pending = { text: text.replace(/\\$/, '').trim(), line: i + 1 }; return; }
      push(text, i + 1);
      return;
    }
    for (const span of raw.matchAll(/`([^`]+)`/g)) push(span[1], i + 1);
  });
  return found;
}

/** Resolve an invocation to its command node, then check every flag it passes. */
export function checkInvocation({ command, line }, tree, file) {
  const tokens = tokenize(command).slice(1); // drop "spool"
  const path = [];
  let node = tree.get('');
  let i = 0;
  for (; i < tokens.length; i++) {
    const canonical = node.commands.get(tokens[i]);
    if (!canonical) break;
    const next = tree.get([...path, canonical].join(' '));
    if (!next) break;
    path.push(canonical);
    node = next;
  }
  const where = `${file}:${line} \`${command}\``;
  assert.ok(
    path.length > 0 || tokens.every((t) => t.startsWith('-')),
    `${where} names no spool command (did "${tokens[0]}" get renamed?)`
  );
  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') break; // everything after belongs to the gated command
    if (!token.startsWith('-')) continue;
    const flag = token.replace(/^\[|[\],.;)]+$/g, '').split('=')[0];
    if (!flag.startsWith('-')) continue;
    assert.ok(
      node.options.has(flag),
      `${where} passes ${flag}, which \`spool ${path.join(' ')} --help\` does not offer`
    );
  }
  return path.join(' ');
}

