#!/usr/bin/env python3
"""Make a qemu-system-arm build relocatable: copy the shared libraries it
needs from the build machine (Homebrew, apt) next to it and point the binary
at them, so it runs on a machine without those packages.

  relocate.py ROOT        ROOT/bin/qemu-system-arm -> ROOT/lib/*

macOS: dependencies from `otool -L` outside /usr/lib and /System are copied
and rewritten to @executable_path/../lib (the binary) or @loader_path (the
libraries), then everything is ad-hoc signed again: arm64 macOS won't run a
binary whose signature install_name_tool invalidated.
Linux: dependencies from `ldd` other than glibc's own are copied and the
rpaths set to $ORIGIN/../lib and $ORIGIN (patchelf).
"""
import os
import re
import shutil
import subprocess
import sys

GLIBC = re.compile(r"^(linux-vdso|ld-linux|libc|libm|libpthread|libdl|librt|libresolv|libutil)\.so")


def run(*cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def macos(root):
    exe = os.path.join(root, "bin", "qemu-system-arm")
    lib = os.path.join(root, "lib")
    todo, done = [exe], set()
    while todo:
        f = todo.pop()
        if f in done:
            continue
        done.add(f)
        os.chmod(f, 0o755)
        lines = run("otool", "-L", f).splitlines()[1:]
        for line in lines:
            dep = line.strip().split(" (")[0]
            if dep.startswith(("/usr/lib/", "/System/")) or dep.startswith("@executable_path") \
                    or dep.startswith("@loader_path"):
                continue
            src = dep
            if dep.startswith("@rpath/"):
                # Homebrew libraries name themselves by absolute path; an
                # @rpath one is found next to the library that needs it
                src = os.path.join(os.path.dirname(os.path.realpath(f)), dep[len("@rpath/"):])
            src = os.path.realpath(src)
            name = os.path.basename(dep)
            dst = os.path.join(lib, name)
            if os.path.basename(f) == name:          # its own id line
                continue
            if not os.path.exists(dst):
                shutil.copy2(src, dst)
                os.chmod(dst, 0o755)
                run("install_name_tool", "-id", "@loader_path/" + name, dst)
                todo.append(dst)
            new = ("@executable_path/../lib/" if f == exe else "@loader_path/") + name
            run("install_name_tool", "-change", dep, new, f)
    for f in done:
        run("codesign", "--force", "--sign", "-", f)
    for f in sorted(done):
        print(run("otool", "-L", f))


def linux(root):
    exe = os.path.join(root, "bin", "qemu-system-arm")
    lib = os.path.join(root, "lib")
    copied = []
    for line in run("ldd", exe).splitlines():
        m = re.match(r"\s*(\S+) => (\S+)", line)
        if not m or GLIBC.match(m.group(1)):
            continue
        dst = os.path.join(lib, m.group(1))
        shutil.copy2(os.path.realpath(m.group(2)), dst)
        os.chmod(dst, 0o755)
        copied.append(dst)
    run("patchelf", "--set-rpath", "$ORIGIN/../lib", exe)
    for f in copied:
        run("patchelf", "--set-rpath", "$ORIGIN", f)
    print(run("ldd", exe))


if __name__ == "__main__":
    root = sys.argv[1]
    os.makedirs(os.path.join(root, "lib"), exist_ok=True)
    (macos if sys.platform == "darwin" else linux)(root)
