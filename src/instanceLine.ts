// What v5brain.sh says about the instance it started, e.g.
//   [v5brain] instance 0: QMP /tmp/v5qmp.sock, log ~/re/qemu-runs/console.txt,
//     field view http://localhost:8765/, brain screen http://localhost:8765/screen,
//     USB /tmp/ttyV5sys /tmp/ttyV5user
// (one line). No VS Code imports: the tests run it under plain Node.

export interface Running {
  id: number;
  viewPort: number;
  ttySys?: string;             // the brain's USB serial ports (--usb)
  ttyUser?: string;
  usbipPort?: number;          // its USB/IP server on localhost (--usbip)
  uploadSock?: string;         // v5upload.py's way into its system port (no restart)
  gdbPort?: number;            // v5gdb_bridge.py's GDB port on localhost (--gdb); output on +1
}

const LINE = /\[v5brain\] instance (\d+):[^\n]*/;

export function parseInstanceLine(text: string): Running | undefined {
  const line = LINE.exec(text);
  if (!line) return undefined;
  const view = /field view http:\/\/localhost:(\d+)\//.exec(line[0]);
  if (!view) return undefined;
  const out: Running = { id: +line[1], viewPort: +view[1] };
  const usb = /, USB (\S+) (\S+?)(?:,|\s*$)/.exec(line[0]);
  if (usb) {
    out.ttySys = usb[1];
    out.ttyUser = usb[2];
  }
  const usbip = /USB\/IP localhost:(\d+)/.exec(line[0]);
  if (usbip) out.usbipPort = +usbip[1];
  const upload = /, upload (\S+?)(?:,|\s*$)/.exec(line[0]);
  if (upload) out.uploadSock = upload[1];
  const gdb = /, GDB localhost:(\d+)/.exec(line[0]);
  if (gdb) out.gdbPort = +gdb[1];
  return out;
}
