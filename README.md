# V5 Brain Simulator for VS Code

Runs the [V5 Simulacrum](https://github.com/UNSW-Robotics-Competition-Club/v5-simulacrum) VEX V5 brain simulator from VS Code, on Windows (through WSL) or macOS:

- **Brain screen** as a pane: the real VEXos screen. Click or drag on it to touch it. The buttons under it press the brain's button (tap = Back/Home, hold 1.5 s = stop the program, hold 5 s = power off).
- **Device dashboard** and **field view** as panes: live motor and sensor readings, and the robot on the field. Click the field view, then drive with the keyboard or a gamepad.
- **Configure Ports**: the robot's port map. Pick the device on each of the 21 smart ports and the 3-wire ports A–H, set cartridges, reversals, tracking wheels, distance sensor mounts and the drivetrain, drag a device to move it, then **Apply & restart sim**. It reads and writes v5-sim's robot presets (`.args` files) and shows the problems the simulator would refuse before you start it.
- **Run Program on Sim**: install a `.bin` in a slot and run it, or upload a PROS project with the PROS CLI, where VEXcode's Download button can't see the simulated brain (macOS, or WSL without usbip-win2). **Open Program Terminal** shows the program's output.
- Start, stop and restart the simulator from the status bar (`V5 Sim`) or the command palette (`V5 Sim: ...`).

## Requirements

- **macOS** 13 or later (Apple Silicon or Intel), or **Windows 10/11 with WSL** (the simulator runs in Linux there; the extension offers to install WSL with Ubuntu if it's missing).
- An internet connection the first time: the extension downloads VEX's firmware (VEXos 1.1.5.0) from VEX's own server. It can't come with the extension: VEX's firmware isn't ours to redistribute.

Nothing else: the platform builds of the extension include the simulator (QEMU with the VEX device models, Python, the robot simulator).

## Install

1. Get the `.vsix` for your computer from the latest **bundle** run (repository's **Actions** tab → **bundle** → the newest run → **Artifacts**), and unzip it:
   - `v5-simulacrum-vscode-darwin-arm64`: a Mac with Apple Silicon (M1 or later);
   - `v5-simulacrum-vscode-darwin-x64`: an Intel Mac;
   - `v5-simulacrum-vscode-win32-x64`: Windows.
2. In VS Code (no terminal needed):
   - **Extensions** view (the squares icon in the left bar) → the **`…`** menu at its top → **Install from VSIX…** → pick the file;
   - or right-click the `.vsix` in VS Code's Explorer → **Install Extension VSIX**;
   - or the Command Palette (⇧⌘P on a Mac, Ctrl+Shift+P on Windows) → **Extensions: Install from VSIX…**.
3. **V5 Sim: Start**. The first time, it unpacks the simulator into `~/.v5-simulacrum` (inside WSL on Windows) and downloads VEXos, in a few seconds; then the brain screen opens. **V5 Sim: Repair Simulator** does that again if anything goes wrong.

### For simulator developers

A clone of v5-simulacrum (or v5-sim) set up with its `scripts/setup.sh` takes over from the bundled simulator when it's a workspace folder, next to one (`../v5-simulacrum`), in your home folder (`~/v5-simulacrum`) or set in `v5sim.repoPath` (its Windows path on Windows). The runtime-free `.vsix` from the **package** workflow only works that way. To build it yourself:

```sh
npm ci
npm run package          # -> v5-simulacrum-vscode-<version>.vsix (no bundled simulator)
code --install-extension v5-simulacrum-vscode-*.vsix
```

Or open this folder in VS Code and press F5 to run it in an Extension Development Host. The bundled runtimes are built by `bundle/build-runtime.sh` (see `.github/workflows/bundle.yml`).

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

- The darwin `.vsix` files include the simulator: no Homebrew, Xcode tools or setup script needed. Real motor firmware (`--motor-fw`) doesn't run properly on a Mac (see the simulator's SIMULATOR.md section 7); the default motor model does.
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
