import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { options, parse, serialize, tokenize, validate } from '../src/robotConfig';

// The v5-sim checkout, for its shipped presets and robot.py's own parser.
const REPO = process.env.V5SIM_REPO ?? path.resolve(__dirname, '../../../v5-sim');
const ROBOTS = path.join(REPO, 'sim', 'robots');
const haveRepo = fs.existsSync(ROBOTS);
const load = (ref: string) => {
  try { return fs.readFileSync(path.join(REPO, 'sim', ref), 'utf8'); } catch { return undefined; }
};

test('tokenize follows robot.py: several per line, # comments, BOM', () => {
  assert.deepEqual(tokenize('﻿--imu 7 --optical 8   # a comment --gps 9\n\n--radio 21'),
    ['--imu', '7', '--optical', '8', '--radio', '21']);
});

test('options pairs values, keeps = and flags', () => {
  assert.deepEqual(options(['--start=-36:-60:0', '--no-noise', '--imu', '7', '@x.args']),
    [['--start', '-36:-60:0'], ['--no-noise'], ['--imu', '7'], ['@', 'x.args']]);
});

test('a port map parses and comes back the same', () => {
  const text = `# header line
--drive 1r,2r,3:4r,5r,6:blue --holonomic x --wheel-rpm 333
--wheel-diameter 3.17 --track 12.3 --start=-36:-60:0
--motor 7r:green --intake 7:4 --motor-fw 7
--motor 16:red --arm 16:5:10:2
--rotation 8r:strafe:2:0:-2.276
--rotation 9:motor16
--distance 13:left:0:0
--radio 11:partner
--adi 22:A=bumper,C=encoder,F=pot:16
--blocks random:24:7 --physics mujoco --no-noise
`;
  const { config, issues } = parse(text);
  assert.deepEqual(issues, []);
  assert.deepEqual(config.header, ['header line']);
  assert.equal(config.drive?.start, '-36:-60:0');
  assert.deepEqual(config.ports[7], { kind: 'motor', reversed: true, cart: 'green', intake: true, intakeCap: '4', firmware: true });
  assert.equal(config.ports[16].arm, '5:10:2');
  assert.deepEqual(config.ports[8], { kind: 'rotation', reversed: true, source: 'strafe', diameter: '2', x: '0', y: '-2.276' });
  assert.deepEqual(config.extra, [['--blocks', 'random:24:7'], ['--physics', 'mujoco'], ['--no-noise']]);
  const again = parse(serialize(config)).config;
  assert.deepEqual(again, config);
  assert.ok(serialize(config).includes('--start=-36:-60:0'));
});

test('validate catches what robot.py would refuse', () => {
  const msgs = (text: string) => validate(parse(text).config).map(i => `${i.severity}:${i.port ?? ''}:${i.message}`);
  assert.deepEqual(msgs('--drive 1,2:3,4:blue --imu 10'), []);
  assert.ok(msgs('--drive 1,2:3,4:blue --imu 2').some(m => m.startsWith('error:2:')));
  assert.ok(msgs('--drive 1,2,3:4,5,6:blue --holonomic x').some(m => m.includes('two motors a side')));
  assert.ok(msgs('--drive 1:2:blue --adi 22:B=encoder').some(m => m.includes('A, C, E or G')));
  assert.ok(msgs('--motor 7:green --intake 7').some(m => m.includes('needs a drive')));
  assert.ok(parse('--imu 23').issues.some(i => i.message.includes('not a smart port')));
  assert.ok(msgs('').some(m => m.includes('at least one device')));
  assert.ok(msgs('--radio 11 --controller 1').some(m => m.startsWith('warning') && m.includes('replaces')));
});

test('a second device on a port is kept and reported', () => {
  const { config, issues } = parse('--imu 7 --optical 7');
  assert.equal(config.ports[7].kind, 'imu');
  assert.deepEqual(config.extra, [['--optical', '7']]);
  assert.equal(issues[0].port, 7);
});

for (const file of haveRepo ? fs.readdirSync(ROBOTS).filter(f => f.endsWith('.args')) : []) {
  test(`shipped preset ${file}: no issues, round-trips`, () => {
    const text = fs.readFileSync(path.join(ROBOTS, file), 'utf8');
    const { config, issues } = parse(text, load);
    assert.deepEqual(issues, []);
    assert.deepEqual(validate(config).filter(i => i.severity === 'error'), []);
    assert.deepEqual(parse(serialize(config), load).config, config);
  });
}

// robot.py itself reads the original and the rewritten file the same way.
const python = process.env.V5SIM_PYTHON ?? 'python3';
const pyCheck = `
import sys
from v5sim.robot import parser
a, b = (vars(parser().parse_args(['@' + f])) for f in sys.argv[1:3])
norm = lambda v: sorted(map(repr, v)) if isinstance(v, list) else repr(v)  # per-port lists: order is free
for k in sorted(set(a) | set(b)):
    if norm(a.get(k)) != norm(b.get(k)):
        print(k, repr(a.get(k)), repr(b.get(k)))
        sys.exit(1)
`;
for (const file of haveRepo ? fs.readdirSync(ROBOTS).filter(f => f.endsWith('.args')) : []) {
  test(`robot.py parses ${file} and its rewrite the same`, () => {
    const orig = path.join(ROBOTS, file);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5args-')), file);
    fs.writeFileSync(tmp, serialize(parse(fs.readFileSync(orig, 'utf8'), load).config));
    execFileSync(python, ['-c', pyCheck, orig, tmp], { cwd: path.join(REPO, 'sim'), stdio: 'pipe' });
  });
}
