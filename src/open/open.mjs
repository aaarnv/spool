import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { platform } from "node:os";
import { resolveConfig } from "../publish/publish.mjs";

const DEFAULT_HOST = "https://spoolkit.dev";

// A published spool writes share/published.json {url}; open that, else the dashboard.
async function resolveUrl(workdir) {
  const pub = join(workdir, "share", "published.json");
  if (existsSync(pub)) {
    try {
      const { url } = JSON.parse(await readFile(pub, "utf8"));
      if (url) return url;
    } catch {
      /* fall through to dashboard */
    }
  }
  const { host } = await resolveConfig();
  return `${host || DEFAULT_HOST}/dashboard`;
}

// Hand a URL to the OS opener; print it when there's no opener (or SPOOL_OPEN_PRINT).
export function launch(url) {
  const cmd = platform() === "darwin" ? "open" : platform() === "linux" ? "xdg-open" : null;
  if (!cmd || process.env.SPOOL_OPEN_PRINT) {
    console.log(url);
    return;
  }
  console.log(`opening ${url}`);
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

export async function openSpool(workdir = ".") {
  launch(await resolveUrl(resolve(workdir)));
}
