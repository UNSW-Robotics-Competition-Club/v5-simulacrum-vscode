# Changelog

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
