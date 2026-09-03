// Where spool-mcp talks to, and where it keeps the little state it owns.
//
// Resolution is the CLI's, not a second one: `resolveConfig` in src/publish/publish.mjs
// is the single answer to "which host, which token", and this module only layers
// SPOOL_TOKEN on top of it as an alias for SPOOL_PUBLISH_TOKEN. An MCP server that
// resolved credentials differently from `spool publish` would be a second source of
// truth for the one fact both of them are wrong about when it drifts.
//
// The state directory holds exactly one kind of file: the events cursor, one per
// (host, token) pair. See cursor.mjs for why it is keyed by a hash and never by the
// token itself.

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { resolveConfig } from '../../src/publish/publish.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));

/** The name and version the server introduces itself to a client with. */
export const SERVER_NAME = 'spool';
export const SERVER_VERSION = pkg.version;

/** Where the cursor lives. Overridable so tests never touch a real home directory. */
export function stateDir(env = process.env) {
  return env.SPOOL_MCP_HOME || join(homedir(), '.spool-mcp');
}

/**
 * Resolve the host and token this server acts as.
 *
 * `SPOOL_TOKEN` is the name the MCP config uses and wins when set; everything below it
 * is the CLI's own order (SPOOL_PUBLISH_TOKEN, then ~/.spool.json, then the default
 * host). A missing token is not an error here — the server starts, and every tool that
 * needs one says so in its own answer rather than the process dying at launch with a
 * message no MCP client would ever show.
 */
export async function loadConfig({ host, token, env = process.env } = {}) {
  const resolved = await resolveConfig({
    host: host || env.SPOOL_HOST || undefined,
    token: token || env.SPOOL_TOKEN || undefined,
  });
  return {
    host: resolved.host,
    token: resolved.token || null,
    /** Identifies the (host, token) pair on disk without ever writing the token down. */
    ownerHash: ownerHash(resolved.host, resolved.token),
  };
}

/** A stable, non-reversible id for one (host, token) pair. */
export function ownerHash(host, token) {
  return createHash('sha256').update(`${host}\n${token || 'anonymous'}`).digest('hex').slice(0, 16);
}

/** The one sentence every tool prints when there is no token to act with. */
export const NO_TOKEN =
  'no spool token: set SPOOL_TOKEN (or SPOOL_PUBLISH_TOKEN) in the MCP server env, or run `spool login`';
