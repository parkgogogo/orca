# parkgogogo/orca fork

`fork-build` is the branch this fork is built and installed from:

- `dsh-history`: native DeepSeek Harness (DSH) session history, search and Chat view
  (upstream PRs #27950 and #27949, plus this fork's work on top).
- Updates compiled out: the build sets `ORCA_UPDATES_DISABLED`, so the app never checks
  for, offers, downloads or installs official releases, which would replace this build.
  `src/main/updater/updater-availability.ts` is the one gate every update path uses.

## Build (macOS)

```bash
git checkout fork-build
npx -y pnpm@12.14.0 install --frozen-lockfile
npx -y pnpm@12.14.0 run build:mac            # unsigned local build in dist/
```

Set `ORCA_ENABLE_UPDATES=1` when building to keep the official updater instead.

## Updating the fork

Merge `stablyai/orca` `main` into `dsh-history`, then `dsh-history` into `fork-build`,
and rebuild.
