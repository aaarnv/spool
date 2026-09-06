import { resolveConfig } from '../publish/publish.mjs';

// Require a configured platform credential before local media work starts. Login
// validates credentials; publishing/hosted services authenticate them again. This
// local prerequisite deliberately adds no network dependency to local recording.
export async function requireSpoolToken(opts = {}) {
  const { token } = await resolveConfig(opts);
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error(
      'A Spool API key is required to create a spool. Run `spool login`, or set ' +
      'SPOOL_PUBLISH_TOKEN to your platform API key from https://spoolkit.dev/dashboard/api-keys. Voice-provider keys do not ' +
      'replace a Spool API key; --no-publish still requires one.'
    );
  }
}
