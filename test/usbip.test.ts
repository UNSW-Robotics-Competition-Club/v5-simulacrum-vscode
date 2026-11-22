import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INTEROP_REPAIR, USBIP_PINNED_VERSION, USBIP_RELEASE_URL, USBIP_WINGET_ID, WINGET_INSTALL_ARGS,
  attachedVport, parseAttachedPort, resolveVport, wingetCodeHex, wingetOutcome,
} from '../src/usbip';

const PORT_OUT = `Imported USB devices
====================
Port 01: device in use at High Speed(480Mbps)
         unknown vendor : unknown product (2888:0501)
           -> usbip://localhost:3301/1-1
           -> remote bus/dev 001/001
           -> serial ''
Port 02: device in use at High Speed(480Mbps)
         unknown vendor : unknown product (2888:0501)
           -> usbip://localhost:3300/1-1
`;

test('parses the Windows port from usbip attach output', () => {
  assert.equal(parseAttachedPort('succesfully attached to port 1\r\n'), 1);
  assert.equal(parseAttachedPort('successfully attached to port 12'), 12);
  assert.equal(parseAttachedPort('usbip: error: cannot connect'), undefined);
});

test('finds which Windows port holds a given USB/IP server', () => {
  assert.equal(attachedVport(PORT_OUT, 3301), 1);
  assert.equal(attachedVport(PORT_OUT, 3300), 2);
  assert.equal(attachedVport(PORT_OUT, 3302), undefined);
  assert.equal(attachedVport('Imported USB devices\n====================\n', 3300), undefined);
});

test('the interop repair registers WSLInterop now and at every boot', () => {
  assert.match(INTEROP_REPAIR, /\/etc\/binfmt\.d\/WSLInterop\.conf/);
  assert.match(INTEROP_REPAIR, /\/proc\/sys\/fs\/binfmt_misc\/register/);
  assert.match(INTEROP_REPAIR, /:WSLInterop:M::MZ::\/init:PF/);
});

test('the driver install is pinned, exact, and needs no prompts but UAC', () => {
  assert.deepEqual(WINGET_INSTALL_ARGS.slice(0, 4), ['install', '--id', USBIP_WINGET_ID, '--exact']);
  assert.equal(WINGET_INSTALL_ARGS[WINGET_INSTALL_ARGS.indexOf('--version') + 1], USBIP_PINNED_VERSION);
  assert.ok(WINGET_INSTALL_ARGS.includes('--accept-package-agreements'));
  assert.ok(WINGET_INSTALL_ARGS.includes('--accept-source-agreements'));
  assert.match(USBIP_RELEASE_URL, new RegExp(`/releases/tag/v\.${USBIP_PINNED_VERSION.replace(/\./g, '\.')}$`));
});

test('the attached port comes from usbip port when attach output does not say', () => {
  assert.equal(resolveVport('succesfully attached to port 3', PORT_OUT, 3301), 3);
  assert.equal(resolveVport('Erfolgreich verbunden', PORT_OUT, 3301), 1);   // other wording
  assert.equal(resolveVport('error: timed out', PORT_OUT, 3302), undefined);
});

test('the interop repair creates /etc/binfmt.d first', () => {
  assert.match(INTEROP_REPAIR, /^mkdir -p \/etc\/binfmt\.d && /);
});

test('a cancelled driver install is not a failure', () => {
  assert.equal(wingetOutcome(-1978334964), 'cancelled');        // 0x8A15010C: UAC "No" or installer Cancel
  assert.equal(wingetOutcome(0x8A15010C), 'cancelled');         // unsigned form
  assert.equal(wingetOutcome(undefined), 'cancelled');          // terminal closed first
});

test('winget exit codes that are the PC, not the extension', () => {
  assert.equal(wingetOutcome(-1978334967), 'restart');          // 0x8A150109 reboot to finish
  assert.equal(wingetOutcome(-1978334966), 'restart');
  assert.equal(wingetOutcome(-1978334965), 'restart');
  assert.equal(wingetOutcome(-1978334961), 'blocked');          // 0x8A15010F policy
  assert.equal(wingetOutcome(-1978334969), 'offline');          // 0x8A150107
});

test('other winget exit codes are failures, shown as winget lists them', () => {
  assert.equal(wingetOutcome(-1978334955), 'failed');           // 0x8A150115 installer error
  assert.equal(wingetOutcome(1), 'failed');
  assert.equal(wingetCodeHex(-1978334964), '0x8A15010C');
  assert.equal(wingetCodeHex(1), '0x00000001');
});
