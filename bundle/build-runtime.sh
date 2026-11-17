#!/bin/bash
# Build the simulator runtime the extension bundles, for this machine:
#   bundle/build-runtime.sh <v5-simulacrum checkout> <out dir>
#   -> <out>/runtime-<platform>.tar.gz with
#      runtime/qemu/{bin/qemu-system-arm,lib/*}   headless QEMU + its libraries
#      runtime/python/                             a standalone CPython 3.12
#      runtime/sim/                                the simulator's scripts and sim/
#      runtime/manifest.json
# No VEX firmware: the extension downloads VEXos from VEX on first start.
# Env: PBS_TAG pins the python-build-standalone release (default: latest);
# GH_TOKEN for GitHub API calls (CI).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SIM=$(cd "$1" && pwd)
OUT=$(mkdir -p "$2" && cd "$2" && pwd)
QEMU_TAG=v11.1.2
case $(uname -s)-$(uname -m) in
  Darwin-arm64)  PLAT=darwin-arm64 TRIPLE=aarch64-apple-darwin ;;
  Darwin-x86_64) PLAT=darwin-x64   TRIPLE=x86_64-apple-darwin ;;
  Linux-x86_64)  PLAT=linux-x64    TRIPLE=x86_64-unknown-linux-gnu ;;
  *) echo "no runtime build for $(uname -sm)" >&2; exit 1 ;;
esac
echo "== runtime for $PLAT"

echo "== build tools"
if [ "$PLAT" = linux-x64 ]; then
  sudo apt-get update -q
  sudo apt-get install -y -q ninja-build pkg-config gcc libglib2.0-dev libpixman-1-dev \
    flex bison git python3-venv patchelf curl
else
  brew install ninja meson pkg-config glib pixman || true
fi

echo "== QEMU $QEMU_TAG, headless"
if [ ! -d ~/re/qemu/.git ]; then
  mkdir -p ~/re
  git clone -q --depth 1 --branch "$QEMU_TAG" https://gitlab.com/qemu-project/qemu.git ~/re/qemu
fi
# Only what the brain needs: no display back ends, audio, network, USB host,
# crypto... so the binary links little more than glib and pixman. The screen
# goes to the extension through the robot sim's /screen page.
export V5SIM_QEMU_CONFIGURE="--without-default-features --enable-pixman --enable-fdt=internal"
bash "$SIM/scripts/qemu_install_vex.sh"

R=$OUT/runtime
rm -rf "$R" && mkdir -p "$R/qemu/bin" "$R/qemu/lib"
cp ~/re/qemu/build/qemu-system-arm "$R/qemu/bin/"
strip "$R/qemu/bin/qemu-system-arm" 2>/dev/null || true
python3 "$HERE/relocate.py" "$R/qemu"

echo "== Python (python-build-standalone)"
api() { curl -fsSL ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} "$@"; }
tag=${PBS_TAG:-$(api https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["tag_name"])')}
base=https://github.com/astral-sh/python-build-standalone/releases/download/$tag
sums=$(curl -fsSL "$base/SHA256SUMS")
line=$(echo "$sums" | grep -E " cpython-3\.12\.[0-9]+\+$tag-$TRIPLE-install_only_stripped\.tar\.gz$" | head -1)
[ -n "$line" ] || { echo "no CPython 3.12 for $TRIPLE in $tag" >&2; exit 1; }
sum=${line%% *}; file=${line##* }
curl -fsSL -o "$OUT/$file" "$base/$file"
got=$( (shasum -a 256 "$OUT/$file" 2>/dev/null || sha256sum "$OUT/$file") | cut -d' ' -f1)
[ "$got" = "$sum" ] || { echo "$file: SHA-256 mismatch" >&2; exit 1; }
tar -xzf "$OUT/$file" -C "$R"          # -> runtime/python/
rm -f "$OUT/$file"
"$R/python/bin/python3" -c 'import sys; print("python", sys.version)'

echo "== simulator files"
mkdir -p "$R/sim/scripts" "$R/sim/sim"
(cd "$SIM" && for f in scripts/*.sh scripts/*.py; do
   case $f in *_test.sh) ;; *) cp "$f" "$R/sim/scripts/" ;; esac
 done)
for d in v5sim robots skins; do
  rsync -a --exclude __pycache__ --exclude '*.pyc' "$SIM/sim/$d" "$R/sim/sim/"
done
for f in LICENSE COPYING NOTICE THIRD_PARTY.md; do
  [ -f "$SIM/$f" ] && cp "$SIM/$f" "$R/sim/"
done
cat > "$R/QEMU-SOURCE.txt" <<TXT
qemu/bin/qemu-system-arm is QEMU $QEMU_TAG (GPL-2.0-or-later, https://gitlab.com/qemu-project/qemu)
built with the VEX device models and patches in qemu-vex/ of
https://github.com/UNSW-Robotics-Competition-Club/v5-simulacrum ($(git -C "$SIM" rev-parse HEAD)).
Its libraries in qemu/lib (glib, pixman and their dependencies) are under their own licences (LGPL/MIT).
python/ is CPython from https://github.com/astral-sh/python-build-standalone ($tag), PSF licence.
TXT
"$R/python/bin/python3" - "$R/manifest.json" <<PY
import json, sys
json.dump({"platform": "$PLAT", "qemu": "$QEMU_TAG", "python": "$file",
           "sim": "$(git -C "$SIM" rev-parse HEAD)"}, open(sys.argv[1], "w"), indent=2)
PY
tar -C "$OUT" -czf "$OUT/runtime-$PLAT.tar.gz" runtime
ls -l "$OUT/runtime-$PLAT.tar.gz"
