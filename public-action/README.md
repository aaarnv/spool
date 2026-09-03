# spoolkit/action

Connect a GitHub Actions runner to [Spool](https://spoolkit.dev).

Spool turns work into a watchable video: a real browser recording, an AI voiceover, and
word-synced captions, rendered to MP4 and published to a watch link. This action is the
small piece that runs on your runner. It holds no Spool logic of its own.

```yaml
- uses: spoolkit/action@v1
  with:
    token: ${{ secrets.SPOOL_TOKEN }}
```

## What it does

The action always writes `~/.spool.json` on the runner from your token. After that it
takes one of two modes.

**`mode: notify`** posts one event to your Spool host and stops. The host records,
voices, renders and publishes on its own machines. The runner installs nothing, so the
job finishes in seconds. Use this mode when your host supports server-side generation.

**`mode: cli`** (the default today) installs the public `@spoolkit/cli` from npm, plus
ffmpeg and a version-matched headless chromium. A later step in your job then drives
`spool` itself. Use this mode when the recording has to happen on the runner, or when
your host does not serve generation yet.

## Setup

1. Mint a token at <https://spoolkit.dev/dashboard>. It starts with `spk_`.
2. Save it as a repository secret named `SPOOL_TOKEN`, under
   **Settings > Secrets and variables > Actions**.
3. Add the action to a workflow.

The token is masked in the job log. It is the only required input.

## Inputs

| Input | Default | What it is |
| --- | --- | --- |
| `token` | — | Required. Your Spool token (`spk_...`). |
| `host` | `https://spoolkit.dev` | Spool origin. Override only for a self-hosted deployment. Must be https. |
| `mode` | `cli` | `notify` or `cli`. See above. |
| `event` | `""` | notify mode. What happened, for example `pull_request.merged`. |
| `payload` | `{}` | notify mode. A JSON object describing the event. |
| `cli-version` | `latest` | cli mode. npm version range for `@spoolkit/cli`. |
| `install-chromium` | `true` | cli mode. Install the browser the recorder drives. |
| `install-ffmpeg` | `true` | cli mode. Install the encoder the renderer calls. |
| `render-concurrency` | `2` | Sets `SPOOL_RENDER_CONCURRENCY` for the job. A runner has far less memory than a laptop. |

## Outputs

`notify` mode only.

| Output | What it is |
| --- | --- |
| `id` | The reserved spool id. |
| `url` | The watch link for the spool being generated. |
| `job-id` | The render job id, for polling. |

## Example: notify on every merged pull request

```yaml
name: Spool
on:
  pull_request:
    types: [closed]

jobs:
  spool:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: spoolkit/action@v1
        id: spool
        with:
          token: ${{ secrets.SPOOL_TOKEN }}
          mode: notify
          event: pull_request.merged
          payload: |
            { "number": ${{ github.event.pull_request.number }} }

      - run: echo "watch it at ${{ steps.spool.outputs.url }}"
```

If your host does not serve generation yet, this fails with a message that says so and
names `mode: cli`.

## Example: record on the runner

```yaml
      - uses: actions/checkout@v4

      - uses: spoolkit/action@v1
        with:
          token: ${{ secrets.SPOOL_TOKEN }}
          mode: cli

      - run: |
          spool live spool/demo --url "$PREVIEW_URL" --title "What shipped"
          spool finish spool/demo
```

`cli` mode needs a Linux runner: it installs ffmpeg with `apt-get` and chromium with
`--with-deps`.

## Requirements

Node 20 or newer on the runner. GitHub-hosted runners already have it. `cli` mode also
installs Node 20 for the CLI itself.

## Support

Issues and questions: <https://spoolkit.dev>.

The Spool CLI, the web app and the render worker are closed source. This action is not:
it is published under the MIT license so you can read every line that runs on your
runner before you give it a token.
