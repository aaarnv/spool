// Minimal unified-diff parser, zero deps, no syntax highlighting. Both the CLI
// and this web view parse the same diff.patch bytes so hunk indices line up.

export type DiffLine = { kind: "+" | "-" | " "; text: string };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = { path: string; oldPath: string; hunks: DiffHunk[] };

function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

// Split into per-file sections on `diff --git`, then read paths from the
// +++/--- lines and hunks from @@ headers. Unknown/binary sections keep empty
// hunks rather than throwing.
export function parseDiff(text: string): DiffFile[] {
  const sections = text.split(/(?=^diff --git )/m).filter((s) => s.startsWith("diff --git"));
  const files: DiffFile[] = [];

  for (const section of sections) {
    const lines = section.split("\n");
    let oldPath = "";
    let newPath = "";
    const hunks: DiffHunk[] = [];
    let cur: DiffHunk | null = null;

    // Fallback path from the header line for binary/mode-only changes that carry
    // no +++/--- lines: `diff --git a/<old> b/<new>`.
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] || "");
    const headerNew = header ? header[2] : "";

    for (const line of lines) {
      // The ---/+++ headers only appear before a file's first @@; gating on !cur
      // stops a removed content line like "--- a comment" being read as a header.
      if (!cur && line.startsWith("--- ")) {
        oldPath = stripPrefix(line.slice(4).trim());
        continue;
      }
      if (!cur && line.startsWith("+++ ")) {
        newPath = stripPrefix(line.slice(4).trim());
        continue;
      }
      if (line.startsWith("@@")) {
        cur = { header: line, lines: [] };
        hunks.push(cur);
        continue;
      }
      if (!cur) continue;
      // "\ No newline at end of file" is metadata, not a content line.
      if (line.startsWith("\\")) continue;
      const c = line[0];
      if (c === "+") cur.lines.push({ kind: "+", text: line.slice(1) });
      else if (c === "-") cur.lines.push({ kind: "-", text: line.slice(1) });
      else if (c === " ") cur.lines.push({ kind: " ", text: line.slice(1) });
    }

    // Prefer the +++ path unless the file was deleted (/dev/null), then the ---,
    // then the diff --git header (binary/mode-only sections have no +++/---).
    const path =
      newPath && newPath !== "/dev/null"
        ? newPath
        : oldPath && oldPath !== "/dev/null"
          ? oldPath
          : headerNew || newPath || oldPath;
    files.push({ path, oldPath, hunks });
  }

  return files;
}
