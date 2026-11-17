# V5 Brain Simulator for VS Code

Runs the [V5 Simulacrum](https://github.com/UNSW-Robotics-Competition-Club/v5-simulacrum) VEX V5 brain simulator from VS Code, on Windows (through WSL) or macOS:

- **Brain screen** as a pane: the real VEXos screen. Click or drag on it to touch it. The buttons under it press the brain's button (tap = Back/Home, hold 1.5 s = stop the program, hold 5 s = power off).
- **Device dashboard** and **field view** as panes: live motor and sensor readings, and the robot on the field. Click the field view, then drive with the keyboard or a gamepad.
- **Configure Ports**: the robot's port map. Pick the device on each of the 21 smart ports and the 3-wire ports A–H, set cartridges, reversals, tracking wheels, distance sensor mounts and the drivetrain, drag a device to move it, then **Apply & restart sim**. It reads and writes v5-sim's robot presets (`.args` files) and shows the problems the simulator would refuse before you start it.
- **Run Program on Sim**: install a `.bin` in a slot and run it, or upload a PROS project with the PROS CLI, where VEXcode's Download button can't see the simulated brain (macOS, or WSL without usbip-win2). **Open Program Terminal** shows the program's output.
- Start, stop and restart the simulator from the status bar (`V5 Sim`) or the command palette (`V5 Sim: ...`).

## Requirements

- A v5-simulacrum checkout (or the v5-sim dev repo), set up as in its SIMULATOR.md section 2: `bash scripts/setup.sh` in WSL Ubuntu-24.04 on Windows, or in Terminal on a Mac.
- A simulator version with the `/screen` page (`sim/v5sim/brainscreen.py`). Older ones show the dashboard and field view, but not the brain screen.
- Windows VS Code (the simulator runs through `wsl.exe`), VS Code connected to WSL (Remote-WSL), or VS Code on macOS (Apple Silicon or Intel). On macOS and in WSL the scripts run directly.

## Install

From a `.vsix` file, in VS Code (no terminal needed):

- **Extensions** view (the squares icon in the left bar) → the **`…`** menu at its top → **Install from VSIX…** → pick the file;
- or right-click the `.vsix` in VS Code's Explorer → **Install Extension VSIX**;
- or the Command Palette (⇧⌘P on a Mac, Ctrl+Shift+P on Windows) → **Extensions: Install from VSIX…**.

Reload the window if VS Code asks. To build the `.vsix` yourself, or install from the command line:

```sh
npm ci
npm run package          # -> v5-simulacrum-vscode-<version>.vsix
code --install-extension v5-simulacrum-vscode-*.vsix
```

Or open this folder in VS Code and press F5 to run it in an Extension Development Host.

If the simulator checkout isn't one of your workspace folders, next to one (`../v5-simulacrum`) or in your home folder (`~/v5-simulacrum` on a Mac), set `v5sim.repoPath`. Use its Windows path on Windows. The extension also asks for it the first time.

## Use

1. `V5 Sim: Start`. The status bar shows `V5 Sim N` once instance N is up, and the brain screen opens beside your editor.
2. `V5 Sim: Open Device Dashboard` / `Open Field View` for the other panes. Drag any pane to wherever you want it.
3. Get your program onto it:
   - On Windows with usbip-win2, as usual: VEXcode and PROS see the simulated brain on USB, as with `V5Sim` (SIMULATOR.md section 5).
   - Anywhere, **V5 Sim: Run Program on Sim** (or right-click a `.bin` → Run Program on Sim): pick a `.bin` from your `build/` or `bin/` folder and a slot, and the sim restarts with it installed and running. In a PROS project with the `pros` CLI on your PATH, it can instead run `pros upload --slot N --after run . /tmp/ttyV5sys` in a terminal.
   - **V5 Sim: Open Program Terminal** runs `pros terminal` (or `screen`) on the brain's user port for your program's output.
   - Or set `v5sim.program` to a `.bin` to install and start it every time the sim starts.
4. `V5 Sim: Configure Ports` to change the robot. Right-click an `.args` file and choose **Configure Ports** to open that one.
5. `V5 Sim: Stop`. Closing VS Code also stops a simulator it started.

The panes also work with a simulator started elsewhere (`V5Sim start`): with none started from VS Code, the open commands list the running instances.

### Settings

| setting | default | |
|---|---|---|
| `v5sim.repoPath` | (workspace) | the simulator checkout |
| `v5sim.wslDistro` | `Ubuntu-24.04` | Windows: the WSL distribution |
| `v5sim.preset` | `competition` | a preset name in `sim/robots/`, or a path to an `.args` file |
| `v5sim.extraRobotArgs` | | options added to the preset, e.g. `--match 20`, `--physics mujoco` |
| `v5sim.program` / `v5sim.slot` | | a `.bin` to install and run at start |
| `v5sim.instanceId` | `auto` | `auto` or `0`..`9`; instance N serves its pages on port 8765+N |
| `v5sim.usb` | `auto` | `auto`: Windows USB through usbip-win2 when it's installed and no brain is on it yet, else serial ports (`/tmp/ttyV5sys`, `/tmp/ttyV5user`; always on macOS); `usbip`, `pty`, `none` |
| `v5sim.showBrainWindow` | `false` | also open QEMU's own brain window |
| `v5sim.openBrainOnStart` | `true` | open the brain screen pane when the sim starts |

### Port map notes

- Saving rewrites the `.args` file from the port map. The comment block at the top is kept; comments further down are dropped (you're asked once).
- Shipped presets (`sim/robots/*.args`) belong to the simulator repo. Saving one asks whether to overwrite it or save a copy, for example `robot.args` in your project.
- Presets that include another (`@robots/competition.args`, as `pushback-practice` does) show the included devices as dashed tiles. Edit the included file to change them.
- Options the editor has no fields for (`--blocks`, `--goals`, `--match`, `--physics`, `--battery`...) are under **Other options**, one per line.

## macOS notes

- Install the simulator first: clone v5-simulacrum to a path without spaces, then run `bash scripts/setup.sh` in Terminal (it needs Homebrew and `xcode-select --install`). `./v5sim competition` there checks that it works outside VS Code.
- The brain's USB is two serial ports, `/tmp/ttyV5sys` (uploads) and `/tmp/ttyV5user` (program output); instance N's are in `/tmp/v5simN/`. VEXcode's Download button can't see them, so use Run Program on Sim, or the PROS CLI with the port given.
- VS Code started from the Dock doesn't get your shell's PATH; the extension adds Homebrew's folders (`/opt/homebrew/bin`, `/usr/local/bin`) for the simulator's scripts and its terminals.
- `v5sim.wslDistro` isn't used.

## Stopping safely

The extension stops a simulator only through `scripts/v5fleet.sh stop <id>`, a graceful QEMU quit that detaches the USB/IP brain cleanly. It never kills the processes: an ungraceful detach can crash Windows through the usbip-win2 driver (simulator README, "Cautions"). If VS Code is killed, stop the instance with `V5Sim stop <id>` (Windows) or `./v5sim stop <id>` (macOS).

## Development

```sh
npm ci
npm test        # compiles, then node --test (robot preset parser)
```

The tests round-trip every preset in a simulator checkout (`../v5-simulacrum` or `../v5-sim`, or set `V5SIM_REPO`). They also check that the simulator's own option parser reads each original file and its rewrite the same way (needs `python3`; set `V5SIM_PYTHON` for another one).

| file | |
|---|---|
| `src/extension.ts` | commands, status bar |
| `src/simInstance.ts` | start/stop through `scripts/v5brain.sh` / `v5fleet.sh` |
| `src/runner.ts` | runs the scripts through `wsl.exe` or directly (Homebrew's PATH on macOS) |
| `src/instanceLine.ts` | reads v5brain.sh's `[v5brain] instance N: ...` line (no VS Code dependency) |
| `src/runProgram.ts` | Run Program on Sim, Open Program Terminal |
| `src/robotConfig.ts` | `.args` file <-> port map, validation (no VS Code dependency) |
| `src/panels/webPanel.ts` | the brain / dashboard / field panes (iframes on `localhost:8765+N`) |
| `src/panels/portsPanel.ts`, `media/ports.*` | the port map editor |
