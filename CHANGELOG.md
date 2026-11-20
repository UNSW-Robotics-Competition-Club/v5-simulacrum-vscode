# Changelog

## Unreleased

- **"could not open port" with the VEXcode extension installed**: a one-time note, and a Troubleshooting entry, on why a `pros upload` or `cargo v5 upload` sometimes fails and then works: VEXcode's extension checks on the brain every few seconds while VS Code has the focus (a real brain too).
- **Debug on Sim** (V5 Sim: Debug on Sim, or F5 with a `v5sim` launch configuration): debug a vexide or PROS program that uses [v5gdb](https://github.com/vexide/v5gdb) on the simulated brain, with breakpoints, stepping, variables and the call stack, through the C/C++ extension (or Native Debug). The simulator starts with its debugger bridge, the program's output shows in a terminal, and GDB comes from the PROS toolchain or PATH (`v5sim.gdbPath`). A project without v5gdb is offered to have it added (the dependency, and its install call through VS Code's change preview).
- **Run on Sim without a restart**: with the simulator running, Run Program on Sim (and the after-build offer) installs the program on the running brain and starts it, in about a second for most programs, keeping the brain, the robot and the panes as they are. It works without the Windows USB driver and on a Mac, and on a simulator started outside VS Code. Programs now stay in the brain's storage between runs, as on a real brain. A simulator from an older version is restarted with the program, as before.
- **Rust (vexide) projects**: a project whose `Cargo.toml` uses vexide (or has cargo-v5's `[package.metadata.v5]`) runs on the simulator like PROS and VEXcode ones: Run Program on Sim runs its newest `cargo v5 build` (`target/*-vex-v5/{debug,release}/<name>.bin`) in its `slot`, a new build is offered Run on Sim, and on Windows with the USB driver the picker offers `cargo v5 upload`.
- **Out-of-date builds**: running a project whose build is older than its source warns first, with **Build and run** (`pros make`, `cargo v5 build`, or VEXcode's build) or **Run anyway**. Nothing builds unless you choose it.

## 0.3.14 (beta)

- **Closing a pane while the simulator starts** no longer reports an error ("Webview is disposed").

## 0.3.13 (beta)

- **Report a Problem** (V5 Sim menu, sidebar, Command Palette): a form for a bug, idea or question that goes straight to the maintainers, no GitHub account needed. Optionally attaches the V5 Sim log and your setup (home folder and user name taken out) and your project folder (listed before sending; build output, Git data and possible secrets left out). Offline, it saves a zip and opens a prefilled GitHub issue instead.
- **Automatic error reports**: a failed setup or start, and the extension's own errors, are reported to the maintainers (error, versions, OS, and for a failed start the last lines of the log; no code, home folder and user name taken out). Follows VS Code's telemetry setting; `v5sim.errorReporting` turns it off.
- **PROS hot/cold and VEXcode Python run on the simulator** (all platforms): Run Program on Sim and the build offer run what the project's own tools would download: a PROS project's hot/cold pair (the default PROS build, newer than its monolith) or monolith, a VEXcode C++ build, or a VEXcode Python `main.py` with VEX's Python runtime from the VEXcode extension. The simulator installs them linked, as PROS and VEXcode upload them (needs the simulator's `--link`, bundled from this version). A project's own slot (VEXcode's) is used.
- **Run on Sim is easy to find on a Mac**, where VEXcode's Download button can't see the simulator: after a build, the extension offers to run the new program on the simulated brain (or always does, with `v5sim.runOnBuild`); a **▶ Run on Sim** button in the status bar and in VEXcode projects' editor title bar; and a one-time tip saying so. The build offer also appears on Windows without the USB driver.
- **No more "Where is your v5-simulacrum checkout?"**: a package without the simulator inside (the platform-neutral one) downloads the simulator for your computer from the extension's GitHub release (checked against its SHA256SUMS, with progress, once), instead of asking for a developer checkout. A checkout next to the workspace, or `v5sim.repoPath`, is still used when there is one.

## 0.3.12 (beta)

- **Setting up shows its progress**: the first start after installing or updating says how many of the simulator's files are unpacked and for how long, with a progress bar, and writes the same to the V5 Sim output (shown while it unpacks). VEXos's check shows its time too.
- **Slow computers**: unpacking may take up to 10 minutes (was 3) before it counts as failed, for computers that scan every new file.

## 0.3.11 (beta)

- **Folders with spaces**: a robot preset or program in a folder whose path has spaces (`OneDrive - School`, `C:\Users\First Last`) works; it used to stop the robot sim or the program from starting.
- **Installing WSL**: after installing WSL (or a missing distribution) from the prompt, Start sets the simulator up; it used to need a window reload.
- **Starting**: a start that never comes up gives up after two minutes with a "Show log" button, instead of staying "starting". The panes say "starting" meanwhile.
- **PROS without the USB driver (Windows)**: Program Terminal opens the brain's port in WSL (`pros terminal`, else `screen`); PROS upload says why it can't reach the brain and offers the USB driver.
- **Windows USB**: Stop takes the brain off Windows USB even after a window reload, or for a simulator started outside VS Code.
- **Cursor and VS Code side by side**: one editor no longer deletes the simulator the other is running.
- **A simulator started elsewhere** that has stopped is forgotten, so Start works again.
- Smaller: `v5sim.usb: usbip` without usbip-win2 uses serial ports (and says so); an out-of-range `v5sim.slot` is treated as 1; `v5sim.wslDistro` must be a distribution name; Configure Ports no longer suggests overriding an included preset's port (the simulator refuses two devices on one port).

## 0.3.10 (beta)

- **Stop is reliable**: stopping could randomly find the simulator "not running" and leave it running (a race in how the simulator checks that it's up).
- **Controller pane**: keyboard shortcuts (Ctrl+C, Cmd+Z…) no longer press controller buttons, and can't leave one stuck down on a Mac. The power button shows a proper power symbol.
- **Requirements**: macOS 15 (Sequoia) or later; the README said 13.
- **Extension page**: screenshots load for everyone (hosted with the public simulator).
- **License**: LGPL-3.0-or-later, © UNSW Robotics Competition Club (was unlicensed). NOTICE lists the bundled simulator's components and their licenses.

## 0.3.9 (beta)

- **Controller pane** (`V5 Sim: Open Controller`): a drawn V5 controller with its live screen (what your program prints, such as an auton selector), rumble, sticks and buttons. Click its buttons, or use the keys it lists, to work menus on the controller screen.
- **Restyled panes**: Devices and Brain screen match Field and Field control. The brain screen has a Menu button for the page links. The field's colour legend is gone.
- **Windows USB**:
  - The brain shows up on USB even when WSL can't run Windows programs, with a **Fix WSL** button for the cause.
  - One USB connection at a time, which fixes VEXcode's "rx buffer size error" and repeated connect/disconnect sounds.
  - The brain is taken off Windows USB before the simulator stops.
- **USB driver**: offered when usbip-win2 is missing (`V5 Sim: Install USB Driver`).
- **Reloading the window** stops the simulator instead of leaving it running.
- **Hung brain**: a brain stuck printing in a loop can no longer fill the disk (console log capped at 20 MB) or flood the output panel.

## 0.3.2

- Platform builds that include the simulator: no setup on Windows (WSL) or macOS.
- Brain screen pane loads once the simulator's page answers.
