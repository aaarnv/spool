#!/usr/bin/env bash
# Spool installer: clone (or update) the CLI, link it onto PATH, fetch the browser.
#   curl -fsSL https://raw.githubusercontent.com/aaarnv/spool/master/install.sh | bash
set -euo pipefail

DIR="${SPOOL_HOME:-$HOME/.spool/cli}"
REPO="https://github.com/aaarnv/spool.git"

command -v node >/dev/null || { echo "spool needs node >= 20 (https://nodejs.org)"; exit 1; }
command -v git >/dev/null || { echo "spool needs git"; exit 1; }
node -e 'process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)' \
  || { echo "spool needs node >= 20 (found $(node --version))"; exit 1; }

if [ -d "$DIR/.git" ]; then
  echo "» updating existing install in $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "» cloning into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO" "$DIR"
fi

echo "» installing dependencies"
npm install --prefix "$DIR" --silent
echo "» linking \`spool\` onto PATH"
npm link --prefix "$DIR" --silent
echo "» fetching chromium for the recorder"
(cd "$DIR" && npx playwright install chromium)

command -v ffmpeg >/dev/null || echo "⚠ ffmpeg not found — install it (macOS: brew install ffmpeg) before rendering."

cat <<'EOT'

✔ spool installed. Two-minute setup:
  1. Connect this machine:  spool login   (opens your browser; sign in and approve)
     One login covers publishing AND hosted AI voice — no OpenAI key needed.
     (Have your own key? Set OPENAI_API_KEY and it's used automatically instead.
      Headless box? Run `spool login --paste`.)
  2. Set your preferences (optional):  spool setup   (browser, target, engine, bg)
  3. Record your first spool:  spool live spool/my-demo --url http://localhost:3000
     Full workflow for agents: skills/spool/SKILL.md — humans: README.md
EOT
