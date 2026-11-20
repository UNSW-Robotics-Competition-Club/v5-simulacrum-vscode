# Developing the V5 Brain Simulator extension

The user-facing page is [README.md](README.md) (it is also the Marketplace page). This file is for working on the extension or the simulator.

## Build and test

```sh
npm ci
npm test        # compiles, then node --test
npm run package # -> v5-simulacrum-vscode-<version>.vsix without the bundled simulator
```

Or open this folder in VS Code and press F5 for an Extension Development Host.

The tests round-trip every robot preset in a simulator checkout (`../v5-simulacrum` or `../v5-sim`, or set `V5SIM_REPO`). They also check that the simulator's own option parser reads each original file and its rewrite the same way (needs `python3`; set `V5SIM_PYTHON` for another one).

## The bundled simulator

The platform `.vsix` files carry a simulator runtime: headless QEMU with the VEX device models and its libraries, a standalone CPython, and the simulator's scripts and `sim/`. `bundle/build-runtime.sh <v5-simulacrum checkout> <out>` builds one for the machine it runs on. CI (`.github/workflows/bundle.yml`) builds Linux (used in WSL on Windows), Apple Silicon and Intel Mac runtimes from the simulator's `main` branch, smoke-tests each, and packages one `.vsix` per VS Code target. The built QEMU is cached per platform (key: QEMU version, `qemu-vex/` tree, the build scripts), so a push that doesn't change those skips the QEMU build. `QEMU_CACHE` gives the script the same reuse locally.

The extension unpacks the runtime once per version into `~/.v5-simulacrum/runtime-<version>` (inside WSL on Windows), removes older ones, and downloads VEXos into `~/.v5-simulacrum/firmware`.

## Releasing and publishing

1. Bump `version` in `package.json` and add it to `CHANGELOG.md`; push to `main`. The **bundle** workflow builds the three platform packages.
2. Create a GitHub release `v<version>` on that commit with the three `.vsix` files from the bundle run attached (mark it pre-release for a beta). Also attach everything in the run's **release-runtime-assets** artifact (`runtime-<platform>.tar.gz` and `SHA256SUMS`): the platform-neutral package downloads the simulator from there, and until this version's release has them it uses an older release's (logged as such; replaced once they appear).
3. Marketplace: `.github/workflows/publish.yml` publishes the release's packages with trusted publishing (`vsce publish --oidc`); no token is stored. Publishing a full release runs it; **Actions → publish → Run workflow** publishes any tag (a beta, or to the pre-release channel). It runs in the `marketplace` environment, which waits for a maintainer's approval. The Marketplace side is a Trusted Publishing policy on the publisher: owner `UNSW-Robotics-Competition-Club`, repository `v5-simulacrum-vscode`, workflow `publish.yml`, environment `marketplace`.

## Using a simulator checkout

A clone of v5-simulacrum set up with its `scripts/setup.sh` takes over from the bundled simulator when it's a workspace folder, next to one (`../v5-simulacrum`), in your home folder (`~/v5-simulacrum`), or set in `v5sim.repoPath` (its Windows path on Windows). The runtime-free `.vsix` from the **package** workflow only works that way. Panes also attach to a simulator started outside VS Code (`V5Sim start`, `./v5sim start`): with none started from VS Code, the open commands list the running instances.

## Run on Sim and Debug on Sim

Both need a simulator from v5-simulacrum's `main` at or after its live-upload change (the bundle workflow builds the runtime from `main`, so merge the simulator first). An older simulator gets a restart with `--run` instead, and Debug on Sim says it has no debugger bridge.

- **Run on Sim without a restart.** Every `v5brain.sh` start puts `scripts/v5usb_share.py` on the brain's USB system port and prints `upload <socket>` on its instance line. `src/liveUpload.ts` runs `scripts/v5upload.py <socket> <file> --slot N [--link LIB]` through the Runner (in WSL on Windows): VEXos's file transfer, as PROS and vexcom do it, ending with "run". Uploads go one at a time. Exit status 3 (nothing at the socket) falls back to the restart.
- **Debug on Sim.** `v5brain.sh --gdb auto` starts `scripts/v5gdb_bridge.py` on the brain's user port: GDB on `127.0.0.1:35537+2N`, the program's output as text on the next port. WSL2 forwards those ports to Windows. `src/debug/debugOnSim.ts` gets the program onto such a simulator, waits for it to start (`[v5brain] started slot`), and returns a `cppdbg` configuration from the `v5sim` debug type's resolver. VS Code then resolves that as `cppdbg` (it re-resolves a configuration whose type changed), so the extension needs no debug adapter of its own.
- **Testing.** `npm test` covers the pure parts (`programs.ts`, `debug/debugTarget.ts`, `debug/v5gdbSetup.ts`). In the simulator: `sim/tests/test_v5upload.py`, `test_v5gdb_bridge.py` and `scripts/live_upload_test.sh` (set `V5SIM_HOTCOLD` to a built PROS project for hot/cold). A GDB session needs a program built with v5gdb (vexide ≥ 0.9.0-alpha.1 or PROS kernel ≥ 4.2.3): start it with `--gdb auto`, then `arm-none-eabi-gdb <elf> -ex "target remote :35537"`.

## Windows USB

The simulator serves its brain's USB as a USB/IP device on `localhost:3300+N` (`scripts/v5usb_usbip.py`, one client at a time: a second import is refused as busy). `v5brain.sh --usbip` attaches it with usbip-win2's `usbip.exe attach --once`, run from WSL.

- If WSL can't run Windows programs (Ubuntu 24.04's `systemd-binfmt` can unregister WSL interop at boot; `usbip.exe` then fails with "Exec format error"), the extension attaches the brain from Windows itself. It detaches it before the simulator quits and offers **Fix WSL**, which registers `WSLInterop` now and in `/etc/binfmt.d/WSLInterop.conf`.
- Never detach a port after its USB/IP server is gone: that can bugcheck usbip-win2, and its driver keeps re-attaching. `v5fleet.sh stop` and `v5brain.sh`'s exit trap detach first, then stop the server.
- **V5 Sim: Install USB Driver** runs `winget install vadimgrn.usbip-win2 --version 0.9.7.8` (pinned: the version the simulator is tested with).

## Stopping

The extension stops a simulator only through `scripts/v5fleet.sh stop <id>`: detach the USB/IP brain, then a QMP quit. It never kills the processes. VS Code closes output channels before `deactivate()` on a window reload; channel writes are wrapped (`src/safeLog.ts`) so the stop still runs.

## Port map editor notes

- Saving rewrites the `.args` file from the port map. The comment block at the top is kept; comments further down are dropped (you're asked once).
- Shipped presets (`sim/robots/*.args`) belong to the simulator. Saving one asks whether to overwrite it or save a copy, for example `robot.args` in your project.
- Presets that include another (`@robots/competition.args`) show the included devices as dashed tiles. Edit the included file to change them.
- Options the editor has no fields for (`--blocks`, `--goals`, `--match`, `--physics`, `--battery`…) are under **Other options**, one per line.

## macOS notes

- Real motor firmware (`--motor-fw`) doesn't run properly on a Mac (the simulator's SIMULATOR.md section 7); the default motor model does.
- Instance N's serial ports are in `/tmp/v5simN/`.
- VS Code started from the Dock doesn't get your shell's PATH; the extension adds Homebrew's folders (`/opt/homebrew/bin`, `/usr/local/bin`) for the simulator's scripts and its terminals.

## Feedback reports

**V5 Sim: Report a Problem** (`src/feedback/`, `media/feedback.*`) POSTs `multipart/form-data` (`report` JSON + optional `bundle` zip with `report.json`, `log.txt`, `project/…`, `project-skipped.txt`) to `v5sim.feedbackEndpoint`, default `https://v5sim-feedback.unsw-rcc.workers.dev`. On failure, or with the setting empty, it saves the zip and opens a prefilled GitHub issue.

The endpoint is `feedback-worker/`, a Cloudflare Worker on the **UNSW RCC** account: rate-limited (5 a minute per address, and 30 stored reports a minute in all), 14 MB per request, reports in the R2 bucket `v5sim-feedback-reports` under `reports/<day>/<uuid>/`. Deploy with `cd feedback-worker && npm ci && npx wrangler deploy`; the admin token is the Worker secret `ADMIN_TOKEN` (`npx wrangler secret put ADMIN_TOKEN`).

Reading reports:

```sh
cd feedback-worker
V5SIM_FEEDBACK_TOKEN=<ADMIN_TOKEN> npm run reports -- list [yyyy-mm-dd]
V5SIM_FEEDBACK_TOKEN=<ADMIN_TOKEN> npm run reports -- get <yyyy-mm-dd/uuid> [out-dir]
V5SIM_FEEDBACK_TOKEN=<ADMIN_TOKEN> npm run reports -- delete <yyyy-mm-dd/uuid>... [--yes]
```

Bundles contain students' code: open them as untrusted input and don't publish them.

**Deletion requests** ([PRIVACY.md](PRIVACY.md) promises them): `delete` shows each report and asks, then removes its `report.json` and `bundle.zip` from R2 (its download links stop working). The copy in Sentry is separate: find it under **User Feedback** by the `report` tag (the same id) and delete it there; error reports can be found by date and deleted the same way.

Tests beyond `npm test` (they need a Worker, `npx wrangler dev --port 8799` with `ADMIN_TOKEN` in `feedback-worker/.dev.vars`):

```sh
V5SIM_FEEDBACK_TOKEN=<token> node test/feedback-worker.integration.mjs     # modules -> Worker -> R2
E2E_TOKEN=<token> node out/test/e2e/runE2E.js                               # in a downloaded VS Code (E2E_VSCODE=1.85.0 for the oldest)
```

## Error reports (Sentry)

`src/errors/`: failures are sent to Sentry through `vscode.env.createTelemetryLogger`, so VS Code's telemetry level applies (errors at `error`/`all`), plus `v5sim.errorReporting`. The client is a standalone `@sentry/core` client (`src/errors/sentry.ts`): no `Sentry.init`, no global handlers, because the extension host is shared with other extensions. `scrub.ts` takes out the home folder, user name and computer name and rewrites stack frames (ours as `app:///out/src/...`, others as a bare file name). `reportError(stage, error)` at a failure point adds one; stages are tags and part of the grouping.

Packages are built with `--no-dependencies`, so `vscode:prepublish` (run by `vsce package`) bundles `@sentry/core` into `out/src/errors/sentry.js` (`scripts/bundle-sentry.mjs`). CI checks each package with `scripts/check-vsix.mjs`: the bundled reporter must load and send without `node_modules`, or the build fails.

The DSN is `SENTRY_DSN` in `src/errors/errorReporting.ts` (public by design; the club's Sentry project, EU region). Empty turns reporting off. `V5SIM_SENTRY_DSN` overrides it (tests). The Worker has the same DSN as its `SENTRY_DSN` secret, plus `LINK_KEY`.

VS Code blanks every path in error telemetry, ours included, so `reportError` sends its own scrubbed stack as a `TelemetryTrustedValue`. Uncaught errors reach the logger from VS Code itself, without one: they arrive with VS Code's blanked stack (`<REDACTED: user-file-path>`), so catch and `reportError` anything worth a readable trace. That path has no test (the probe can't raise an uncaught error inside this extension).

VS Code never sends extension telemetry during extension tests (and from an unbuilt VS Code), it only logs it to an "Extension Telemetry (Not Sent)" output, so `test/e2e/runErrorReports.ts` checks the real path by opening a downloaded VS Code with the extension and `test/e2e/probe` loaded and no test runner, against a fake Sentry:

```sh
npx tsc -p . && npm run vscode:prepublish && node out/test/e2e/runErrorReports.js   # E2E_VSCODE=1.85.0 for the oldest
```

**Reports in Sentry too.** With the Worker secret `SENTRY_DSN` set (the same DSN works), each Report a Problem submission also appears under Sentry's **User Feedback** with its summary, description, kind, contact and environment, tagged with the report id. The files stay in R2: with the secret `LINK_KEY` set, the feedback has signed download links (`/d/<day>/<uuid>/<file>?sig=`) to `report.json` and `bundle.zip`. The links expire after 60 days (then use `/admin`); anyone who can see the feedback in Sentry can use them until then, and changing `LINK_KEY` revokes them all.

```sh
cd feedback-worker
npx wrangler secret put SENTRY_DSN
npx wrangler secret put LINK_KEY        # any long random string
```

The Worker integration test checks the forwarding and the links against a fake Sentry when the Worker's `SENTRY_DSN` is `http://fbkey@127.0.0.1:8798/7` (in `.dev.vars`, with `LINK_KEY`): `V5SIM_FAKE_SENTRY_PORT=8798 ... node test/feedback-worker.integration.mjs`.

## Source

| file | |
|---|---|
| `src/extension.ts` | commands, status bar, views |
| `src/simInstance.ts` | start/stop through `scripts/v5brain.sh` / `v5fleet.sh`; USB attach/detach when WSL can't |
| `src/runner.ts` | runs the scripts through `wsl.exe` or directly (Homebrew's PATH on macOS) |
| `src/runtime.ts`, `src/runtimeCore.ts` | unpacking the bundled runtime, VEXos download |
| `src/usbip.ts`, `src/usbDriver.ts` | usbip-win2 from Windows; the driver install |
| `src/instanceLine.ts` | reads v5brain.sh's `[v5brain] instance N: ...` line |
| `src/runProgram.ts` | Run Program on Sim, Open Program Terminal |
| `src/robotConfig.ts` | `.args` file <-> port map, validation |
| `src/panels/webPanel.ts` | the brain / devices / field / controller panes (iframes on `localhost:8765+N`) |
| `src/panels/portsPanel.ts`, `media/ports.*` | the port map editor |
| `src/safeLog.ts`, `src/outputBudget.ts` | output channel that can't throw; rate limit for simulator output |
| `src/feedback/`, `media/feedback.*` | Report a Problem: form, project scan, zip, upload, GitHub fallback |
| `src/errors/`, `scripts/bundle-sentry.mjs` | automatic error reports to Sentry |
| `feedback-worker/` | the reports endpoint (Cloudflare Worker + R2), forwarding to Sentry User Feedback |
| `media/icon.svg` | the extension icon (rendered to `media/icon.png`, 256×256) |
