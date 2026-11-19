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
| `media/icon.svg` | the extension icon (rendered to `media/icon.png`, 256×256) |
