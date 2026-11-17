#!/bin/bash
# Run a built runtime the way the extension does, from a fresh folder and
# without the build machine's tools on PATH:
#   bundle/smoke.sh runtime-<platform>.tar.gz
set -euo pipefail
TGZ=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
T=$(mktemp -d /tmp/v5rt.XXXXXX)
tar -xzf "$TGZ" -C "$T"
R=$T/runtime
export PATH=$R/python/bin:/usr/bin:/bin:/usr/sbin:/sbin
export V5SIM_QEMU=$R/qemu/bin/qemu-system-arm V5SIM_PYTHON=$R/python/bin/python3
export V5SIM_RUNS=$T/runs V5SIM_FIRMWARE_DIR=$T/firmware V5SIM_NO_BROWSER=1
echo "== QEMU runs from the bundle"
"$V5SIM_QEMU" -machine help | grep -i vex
echo "== firmware from VEX"
bash "$R/sim/scripts/fetch_firmware.sh"
echo "== boot"
id=7; port=$((8765 + id))
bash "$R/sim/scripts/v5brain.sh" --id $id --headless --usb --robot "@robots/competition.args" \
  > "$T/v5brain.out" 2>&1 < /dev/null &
ok=""
for _ in $(seq 90); do
  if curl -fs -o "$T/screen.png" "http://localhost:$port/screen.png"; then ok=1; break; fi
  sleep 1
done
sleep 6
curl -fsS -o "$T/screen.png" "http://localhost:$port/screen.png" || ok=""
python3 -c 'import struct, sys
d = open(sys.argv[1], "rb").read()
assert d[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">II", d[16:24]) == (480, 272)
print("screen 480x272")' "$T/screen.png" || ok=""
curl -fsS -H 'Content-Type: application/json' -d '{"x": 10, "y": 10, "down": true}' "http://localhost:$port/touch" || ok=""
curl -fsS -H 'Content-Type: application/json' -d '{"x": 10, "y": 10, "down": false}' "http://localhost:$port/touch" || ok=""
bash "$R/sim/scripts/v5fleet.sh" stop $id
sleep 3
cat "$T/v5brain.out" | tail -20
if pgrep -f "$V5SIM_QEMU" >/dev/null; then echo "QEMU still running after stop"; ok=""; fi
cp "$T/screen.png" ./smoke-screen.png 2>/dev/null || true
[ -n "$ok" ] && echo "SMOKE OK" || { echo "SMOKE FAILED"; exit 1; }
