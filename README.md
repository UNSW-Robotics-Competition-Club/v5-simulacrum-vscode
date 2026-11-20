# V5 Brain Simulator

Run a simulated **VEX V5 brain** inside VS Code and test your robot code without a robot. The brain runs VEX's real firmware (VEXos) in an emulator, so your VEXcode, PROS or vexide (Rust) program runs as it does on a brain. Its motors, sensors and drivetrain are simulated on a field you can see and drive.

> **Beta.** Built by the UNSW Robotics Competition Club on [V5 Simulacrum](https://github.com/UNSW-Robotics-Competition-Club/v5-simulacrum). Windows (through WSL) and macOS.

![The field view: the simulated robot on a V5RC field, with its position, heading and speed, the competition switch and the controller's screen](https://raw.githubusercontent.com/UNSW-Robotics-Competition-Club/v5-simulacrum/main/docs/images/vscode/field.png)

## What you get

**The brain's screen**: the real VEXos screen. Click or drag on it to touch it, and use the brain's button underneath (tap for Back/Home, hold to stop the program).

![The brain screen pane showing a program's autonomous selector](https://raw.githubusercontent.com/UNSW-Robotics-Competition-Club/v5-simulacrum/main/docs/images/vscode/brain.png)

**The controller**: what your program prints on the controller screen (an auton selector, for instance), its rumble, and its sticks and buttons as they're pressed. Click its buttons, or use the keys it lists, to work menus on the controller screen.

![The Controller pane: a V5 controller with its screen showing an auton selector](https://raw.githubusercontent.com/UNSW-Robotics-Competition-Club/v5-simulacrum/main/docs/images/vscode/controller.png)

**The field**: the robot on the field, live. Click the field, then drive with the keyboard or a gamepad. Switch competition modes (driver, autonomous, disabled) or run a timed match from **Field control**.

**The devices**: every motor's velocity and position against its target, with volts, amps, power and temperature. Every sensor's reading.

![The Devices pane: live charts of each drive motor's velocity and position](https://raw.githubusercontent.com/UNSW-Robotics-Competition-Club/v5-simulacrum/main/docs/images/vscode/devices.png)

**Your robot's ports**: **V5 Sim: Configure Ports** picks the device on each of the 21 smart ports and the 3-wire ports A–H. It also sets cartridges, reversals, tracking wheels, distance sensor mounts and the drivetrain. It flags anything the simulator would refuse before you start.

## Get started

1. Install the extension: search **V5 Brain Simulator** in VS Code's Extensions view and click **Install**, or [open it on the Marketplace](https://marketplace.visualstudio.com/items?itemName=unsw-robotics-competition-club.v5-simulacrum-vscode). VS Code picks the build for your computer and keeps it up to date.
   - From a terminal: `code --install-extension unsw-robotics-competition-club.v5-simulacrum-vscode`
   - Offline, or for Cursor and VSCodium: download the `.vsix` for your computer (`win32-x64`, `darwin-arm64` for Apple Silicon, `darwin-x64` for Intel Macs) from the [latest release](https://github.com/UNSW-Robotics-Competition-Club/v5-simulacrum-vscode/releases), then run **Extensions: Install from VSIX…**.
   - Prompt your team to install it: add it to your robot project's `.vscode/extensions.json`, and VS Code offers it to anyone who opens the project:
     ```json
     { "recommendations": ["unsw-robotics-competition-club.v5-simulacrum-vscode"] }
     ```
2. Click **V5 Sim** in the activity bar, then **Start the simulator**. The first start unpacks the simulator and downloads VEXos from VEX, which takes a few seconds. The brain screen then opens beside your editor.
3. Open the other panes from the same view, or with **V5 Sim: Open Field View**, **Open Device Dashboard** and **Open Controller**. Drag any pane wherever you want it.

### Requirements

- **Windows 10 or 11 with WSL.** The simulator runs in Ubuntu 24.04 under WSL; the extension offers to install WSL if it's missing.
- **macOS 15 (Sequoia) or later**, Apple Silicon or Intel.
- **Internet for the first start**, to download VEXos from VEX. VEX's firmware isn't ours to ship with the extension.

Everything else (the emulator, Python, the robot simulator) comes inside the extension.

## Get your program onto the brain

- **Windows: download as usual.** VEXcode and PROS see the simulated brain on USB, through the [usbip-win2](https://github.com/vadimgrn/usbip-win2) driver. If the driver isn't installed, the extension offers to install it (**V5 Sim: Install USB Driver**).
- **Anywhere: V5 Sim: Run Program on Sim.** You can also right-click a `.bin` and choose **Run Program on Sim**. Pick your project (or a `.bin`) and a slot. With the simulator running, the program is installed on the running brain and started in about a second (a few seconds for a big PROS library the first time); the robot, the field and the panes stay as they are. With no simulator running, it starts one with the program. No USB driver needed, on Windows or a Mac.
- **What runs**: what your project's own tools would download. A VEXcode C++ build; a PROS project's hot/cold pair (or its monolith, whichever is newer); a VEXcode Python `main.py`; a **vexide (Rust)** project's newest `cargo v5 build` (`target/*-vex-v5/{debug,release}/<name>.bin`, in its `[package.metadata.v5]` slot).
- **Out-of-date builds**: if a source file changed after the build, it asks first: **Build and run** (`pros make`, `cargo v5 build`, or VEXcode's build) or **Run anyway**. Nothing builds unless you choose it.
- **The project's own uploader**: in a PROS project with the `pros` CLI, the picker can run `pros upload`; on Windows with the USB driver, a Rust project can use `cargo v5 upload`.
- **Program output**: **V5 Sim: Open Program Terminal** shows what your program prints.
- **Every start**: set `v5sim.program` to a `.bin` to install and run it each time the simulator starts.

## Debug on Sim

Set breakpoints, step through your code, and look at variables and the call stack while your program runs on the simulated brain. It works with [v5gdb](https://github.com/vexide/v5gdb), a debugger built into the program, in **PROS** (kernel 4.2.3 or later) and **vexide** (0.9.0-alpha.1 or later) projects. VEXcode projects can't be debugged this way.

1. Press **F5** with a `V5 Sim` launch configuration (**Run: Add Configuration…** → **V5 Sim: Debug on Sim (v5gdb)**), or run **V5 Sim: Debug on Sim**.
2. If the project doesn't use v5gdb yet, it offers to add it: the dependency (`cargo add v5gdb`, or `pros c apply v5gdb` from v5gdb's depot) in a terminal you can watch, and the install call through VS Code's change preview, so nothing is written until you apply it. Build, then press F5 again.
3. The simulator starts with its debugger bridge (or installs the program on a running one that has it), the program starts, and the debugger connects and pauses it. Set breakpoints and continue. What the program prints shows in a **V5 program** terminal.

You need **GDB** with ARM support (the PROS extension's toolchain has it; on a Mac `brew install gdb`; set `v5sim.gdbPath` for another) and the **C/C++** extension (or Native Debug in VSCodium). With the install call the extension adds (`stop_motors_on_break`), the motors stop while the program is paused.

A launch configuration can name the project and slot:

```json
{ "type": "v5sim", "request": "launch", "name": "Debug on V5 Sim", "program": "${workspaceFolder}", "slot": 2 }
```

## Settings

| Setting | Default | |
|---|---|---|
| `v5sim.preset` | `competition` | The robot: a preset name, or the path to your own `.args` file (made with **Configure Ports**) |
| `v5sim.extraRobotArgs` | | Options added to the preset, e.g. `--match 20` |
| `v5sim.program` / `v5sim.slot` | | A `.bin` to install and run at start |
| `v5sim.usb` | `auto` | Windows: the brain on USB through usbip-win2 when it's installed, else serial ports. `usbip`, `pty`, `none` |
| `v5sim.wslDistro` | `Ubuntu-24.04` | Windows: the WSL distribution |
| `v5sim.instanceId` | `auto` | Which simulator instance; instance N serves its pages on port 8765+N |
| `v5sim.openBrainOnStart` | `true` | Open the brain screen when the simulator starts |
| `v5sim.runOnBuild` | `ask` | After a build: offer to run it on the simulator, run it (`always`), or nothing (`never`) |
| `v5sim.gdbPath` | | GDB for **Debug on Sim**; empty: the PROS toolchain's, else one on PATH |
| `v5sim.errorReporting` | `true` | Send automatic error reports (also needs VS Code's telemetry on) |
| `v5sim.feedbackEndpoint` | the maintainers' server | Where **Report a Problem** sends reports; empty: save a zip and open a GitHub issue instead |
| `v5sim.repoPath` | | A simulator checkout to use instead of the bundled one (for simulator development) |

## Troubleshooting

**VEXcode doesn't see the brain (Windows).** The brain appears on USB only with the usbip-win2 driver. Without it the simulator falls back to WSL serial ports, which VEXcode can't see. Run **V5 Sim: Install USB Driver**, then restart the simulator.

**"WSL can't run Windows programs".** Ubuntu 24.04 can switch off WSL's ability to run Windows programs at boot. The extension then puts the brain on USB itself and offers **Fix WSL**, which turns it back on now and after reboots.

**macOS: VEXcode's Download button can't see the brain.** On a Mac the brain's USB is two serial ports (`/tmp/ttyV5sys` for uploads, `/tmp/ttyV5user` for program output), not a USB device. Instead:
- **Build as usual**: when the build finishes, the extension offers **Run on Sim**, which installs the new program on the simulated brain (the project's slot, else `v5sim.slot`) and starts it. **Always** stops it asking (setting `v5sim.runOnBuild`).
- **▶ Run on Sim** in the status bar, or in a VEXcode or Rust project's editor title bar, picks a program to run.
- Right-click a `.bin` (or a VEXcode Python `.py`) → **Run Program on Sim**.
- The PROS CLI with the port given: `pros upload --port /tmp/ttyV5sys`.

**`pros upload` (or `cargo v5 upload`) says "could not open port", then works on the second try.** The VEXcode extension checks on the brain every few seconds while VS Code has the focus, and an upload that starts during a check finds the port busy. This happens with a real brain too. Try again, upload from a terminal outside VS Code, or keep the VEXcode extension in a different [profile](https://code.visualstudio.com/docs/configure/profiles) from your PROS projects. **Run Program on Sim** isn't affected.

**Debug on Sim: GDB can't connect, or times out.** The program has to call v5gdb's install first thing (`main` in vexide, `initialize()` in PROS), and be built with debug information: for vexide, a debug build (`cargo v5 build`, not `--release`). **V5 Sim: Show Log** shows the bridge's messages (`[v5gdb] ...`). Two simulators debugging at once use different ports (instance N: 35537+2N).

**Anything else.** **V5 Sim: Show Log** shows what the simulator is doing. **V5 Sim: Repair Simulator** unpacks it again.

**Stopping.** **V5 Sim: Stop**, closing VS Code, or reloading the window all stop the simulator gracefully. It is never killed, because a hard stop can crash Windows' USB driver. If VS Code itself was killed and the simulator is still running, open any pane (**V5 Sim: Open Field View**, for instance), which finds the running simulator, then **V5 Sim: Stop**.

## Feedback

**V5 Sim: Report a Problem** (also in the V5 Sim menu and sidebar) sends a bug report, idea or question to the maintainers; no GitHub account needed. You choose what goes with it:
- **The V5 Sim log and your setup** (on by default): versions, OS, your `v5sim.*` settings. Your home folder and user name are taken out.
- **Your project folder** (off by default): its source files, listed before you send. Build output, `.git`, dependencies, and files that may hold passwords or keys (`.env`, `*.pem`, `.vscode/settings.json`…) are left out; at most 10 MB.

Reports are stored privately for the maintainers; the summary, details and contact also appear in their issue tracker (Sentry), while attached files stay on their server. If the report can't be sent (offline, or `v5sim.feedbackEndpoint` emptied), it's saved as a zip and a prefilled GitHub issue opens for you to attach it.

**Automatic error reports.** When the simulator fails to set up or start, or the extension hits an error, it sends the maintainers a short report: the error, where in the extension it happened, the extension, VS Code and OS versions, and for a failed start the last lines of the V5 Sim log. Your home folder, user name and computer name are taken out, and no code is sent. It follows VS Code's telemetry setting (`telemetry.telemetryLevel`: sent at `all` or `error`, never at `crash` or `off`); `v5sim.errorReporting: false` turns it off for this extension only.

What is sent, where it's kept and for how long: [PRIVACY.md](PRIVACY.md).

Or directly: [GitHub issues](https://github.com/UNSW-Robotics-Competition-Club/v5-simulacrum-vscode/issues). Building the extension or working on the simulator: see [DEVELOPMENT.md](DEVELOPMENT.md).

## License

Copyright © 2026 UNSW Robotics Competition Club. The extension is **LGPL-3.0-or-later** (see [NOTICE](NOTICE), [LICENSE](LICENSE) and [COPYING](COPYING)). The simulator it bundles has its own licenses: [V5 Simulacrum](https://github.com/UNSW-Robotics-Competition-Club/v5-simulacrum) is LGPL-3.0-or-later, QEMU GPL-2.0-or-later, Python the PSF license. NOTICE lists them, and each package carries their license texts. VEX's firmware isn't included; the extension downloads it from VEX.
