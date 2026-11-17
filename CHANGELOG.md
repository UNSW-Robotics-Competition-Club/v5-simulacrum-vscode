# Changelog

## 0.3.10 (beta)

- Controller pane: the power button shows a proper power symbol.

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
