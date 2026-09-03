# Publishing the public action

`public-action/` is the source of the standalone public repository `spoolkit/action`. It
lives here so it is versioned and tested with the rest of the project, and it is pushed
out as its own repository so `uses: spoolkit/action@v1` resolves for anyone.

This procedure creates a **public** repository. Do not run any of it without Aarnav's
explicit approval.

## Why the split exists

This repository went private on 2026-08-21. A GitHub Action referenced as
`uses: owner/repo@ref` is fetched by the runner with the caller's own credentials, so a
private repository cannot serve an action to any workflow outside it. Every external
`uses: aaarnv/spool@master` broke that day.

The public repository holds only the shim: `action.yml`, two dependency-free Node
scripts, their tests, and a README. It contains no CLI source, no platform source and no
render worker source. The root suite's `test/public-action.test.mjs` fails if that ever
stops being true.

## First publish

1. Create the repository. Owner `spoolkit`, name `action`, **public**, no README, no
   license, no `.gitignore`.

   ```
   gh repo create spoolkit/action --public --description "Connect a GitHub Actions runner to Spool."
   ```

2. Push `public-action/` as the new repository's root. `git subtree` keeps the history of
   just that directory, so later pushes stay incremental.

   ```
   cd <this repo>
   git subtree push --prefix=public-action git@github.com:spoolkit/action.git main
   ```

   If the subtree push is refused because the remote is empty, seed it once:

   ```
   git subtree split --prefix=public-action -b public-action-main
   git push git@github.com:spoolkit/action.git public-action-main:main
   git branch -D public-action-main
   ```

3. Tag the release. Consumers pin `@v1`, so `v1` is a moving major tag that must be
   force-updated on every release.

   ```
   git clone git@github.com:spoolkit/action.git /tmp/spool-action
   cd /tmp/spool-action
   git tag -a v1.0.0 -m "v1.0.0"
   git tag -f -a v1 -m "v1"
   git push origin v1.0.0
   git push -f origin v1
   ```

4. Check the two CI jobs in `spoolkit/action` go green. `self-test` is the one that
   matters: it resolves the action the way a consumer does.

5. Verify from outside. In any other repository, run a throwaway workflow with
   `uses: spoolkit/action@v1` and a real `SPOOL_TOKEN`. Until this passes, the action is
   not published, only uploaded.

## Later releases

```
git subtree push --prefix=public-action git@github.com:spoolkit/action.git main
```

Then repeat step 3 with the next patch or minor tag, and move `v1` onto it. Only cut
`v2` for a breaking change to inputs or outputs.

## What must never go in

- Anything from `src/`, `web/`, `worker/`, `mcp/`, `skills/` or `templates/`.
- Any npm dependency. The scripts use the Node standard library only, so there is no
  `dist/`, no bundler, and nothing for a consumer to audit but the files themselves.
- A default token, host or account of ours.

## After it is live

Point the in-repo references at it: `README.md`, `CONTRACTS.md`, `docs/examples/*.yml`.
The workflows in `.github/workflows/` use `uses: ./` instead, because a workflow in this
repository already has this repository checked out.
