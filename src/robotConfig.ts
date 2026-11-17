// A robot preset (.args file for v5-sim's sim/v5sim/robot.py) as a port map,
// and back. No VS Code imports: the tests run it under plain Node.
//
// The file format is robot.py's: argparse options, several per line, `#`
// starts a comment, `@file` includes another preset (relative to sim/).
// Options this model doesn't know (field, match, physics...) are kept as
// they are, in `extra`.

export const SMART_PORTS = 21;
export const ADI_PORT = 22;                       // the brain's own 3-wire ports
export const CARTRIDGES = ['red', 'green', 'blue', '5.5w'] as const;
export const ADI_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
export const ADI_KINDS = ['bumper', 'limit', 'encoder', 'sonar', 'piston', 'gyro',
  'pot', 'potv2', 'line', 'light', 'accel'] as const;
export const ADI_PAIRED = ['encoder', 'sonar'];
export const ADI_SHAFT = ['pot', 'potv2'];
export const DISTANCE_FACES = ['front', 'right', 'back', 'left'];

/** Devices that take just a port. */
export const SIMPLE_KINDS = ['imu', 'optical', 'gps', 'aivision', 'vision', 'controller',
  'magnet', 'tower', 'pneumatic', 'led'] as const;

export type Kind = 'motor' | 'rotation' | 'distance' | 'radio' | 'field-controller'
  | 'adi' | typeof SIMPLE_KINDS[number];

export const KIND_LABELS: Record<Kind, string> = {
  motor: 'Motor', rotation: 'Rotation Sensor', distance: 'Distance Sensor',
  radio: 'VEXnet Radio', 'field-controller': 'Field-control link', adi: '3-Wire Expander',
  imu: 'Inertial Sensor', optical: 'Optical Sensor', gps: 'GPS Sensor',
  aivision: 'AI Vision Sensor', vision: 'Vision Sensor', controller: 'Controller (tethered)',
  magnet: 'Electromagnet', tower: 'Light Tower', pneumatic: 'CTE Pneumatics', led: 'LED',
};

/** One smart device. Values are kept as written (strings) so a file
 *  round-trips without reformatting its numbers. */
export interface Device {
  kind: Kind;
  reversed?: boolean;          // motor, rotation: the `r` after the port
  cart?: string;               // motor
  intake?: boolean;            // motor: --intake P[:CAP]
  intakeCap?: string;
  arm?: string;                // motor: --arm P:<this>, RATIO:LEN:KG[:START:LO:HI]
  firmware?: boolean;          // motor: --motor-fw P
  source?: string;             // rotation: track | strafe | motorN
  diameter?: string;           // rotation (track/strafe)
  x?: string;                  // rotation, distance: offset right, inches
  y?: string;                  // rotation, distance: offset forward, inches
  face?: string;               // distance: front|right|back|left|degrees
  partner?: boolean;           // radio
  team?: string;               // field-controller
  wiring?: string;             // adi: "A=bumper,C=encoder,F=pot:7"
}

export interface DriveMotor { port: number; reversed: boolean }

export interface Drive {
  left: DriveMotor[];
  right: DriveMotor[];
  cart: string;
  holonomic?: string;          // x | mecanum
  wheelDiameter?: string;
  track?: string;
  wheelRpm?: string;
  start?: string;              // X:Y:H
}

export interface Include {
  ref: string;                 // as written after the @
  ports: Record<number, string>; // ports it uses -> label (for the grid)
  missing?: boolean;
}

export interface RobotConfig {
  header: string[];            // the leading comment block, without '#'
  includes: Include[];
  drive?: Drive;
  ports: Record<number, Device>;
  motorFwAll: boolean;
  extra: string[][];           // other options, one array of tokens per option
}

export interface Issue { port?: number; message: string; severity: 'error' | 'warning' }

export function emptyConfig(): RobotConfig {
  return { header: [], includes: [], ports: {}, motorFwAll: false, extra: [] };
}

// ---------------------------------------------------------------- parsing

/** Options with no value. */
const FLAGS = new Set(['--no-builtin-adi', '--no-battery', '--no-noise']);

/** robot.py's _Parser.convert_arg_line_to_args, line by line. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    out.push(...line.split('#', 1)[0].split(/\s+/).filter(Boolean));
  }
  return out;
}

function headerOf(text: string): string[] {
  const header: string[] = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('#')) header.push(t.replace(/^# ?/, ''));
    else if (t === '' && header.length === 0) continue;
    else break;
  }
  return header;
}

/** [option, value?] pairs; @includes come back as ['@', ref]. */
export function options(tokens: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('@')) { out.push(['@', t.slice(1)]); continue; }
    if (!t.startsWith('--')) { out.push([t]); continue; }      // stray value
    const eq = t.indexOf('=');
    if (eq > 0) { out.push([t.slice(0, eq), t.slice(eq + 1)]); continue; }
    if (FLAGS.has(t) || i + 1 >= tokens.length || tokens[i + 1].startsWith('--')
        || tokens[i + 1].startsWith('@')) {
      out.push([t]);
    } else {
      out.push([t, tokens[++i]]);
    }
  }
  return out;
}

function mounted(token: string): DriveMotor | undefined {
  const m = /^(\d+)(r?)$/.exec(token);
  return m ? { port: +m[1], reversed: m[2] === 'r' } : undefined;
}

export type Loader = (ref: string) => string | undefined;

export interface Parsed { config: RobotConfig; issues: Issue[] }

export function parse(text: string, load?: Loader, depth = 0): Parsed {
  const config = emptyConfig();
  const issues: Issue[] = [];
  config.header = headerOf(text);
  const later: string[][] = [];               // need the motors first

  const keep = (opt: string[], why?: string) => {
    config.extra.push(opt);
    if (why) issues.push({ severity: 'warning', message: `${opt.join(' ')}: ${why} (kept as written)` });
  };
  const put = (port: number, dev: Device, opt: string[]) => {
    if (!(port >= 1 && port <= ADI_PORT) || (port === ADI_PORT && dev.kind !== 'adi')) {
      keep(opt, `port ${port} is not a smart port 1..21`);
      return;
    }
    if (config.ports[port]) {
      keep(opt);
      issues.push({ port, severity: 'error', message: `port ${port} has two devices: ${opt.join(' ')} is kept as written` });
      return;
    }
    config.ports[port] = dev;
  };

  for (const opt of options(tokenize(text))) {
    const [name, value = ''] = opt;
    const parts = value.split(':');
    switch (name) {
      case '@': {
        const inc: Include = { ref: value, ports: {} };
        const src = load && depth < 4 ? load(value) : undefined;
        if (src === undefined) {
          inc.missing = true;
          if (load) issues.push({ severity: 'warning', message: `can't read the included preset @${value}` });
        } else {
          const sub = parse(src, load, depth + 1).config;
          inc.ports = usedPorts(sub);
          for (const i of sub.includes) Object.assign(inc.ports, i.ports);
        }
        config.includes.push(inc);
        break;
      }
      case '--drive': {
        const sides = value.split(':');
        const left = (sides[0] ?? '').split(',').filter(Boolean).map(mounted);
        const right = (sides[1] ?? '').split(',').filter(Boolean).map(mounted);
        if (sides.length !== 3 || left.includes(undefined) || right.includes(undefined)) {
          keep(opt, 'expected L[r],..:R[r],..:CART');
          break;
        }
        config.drive = { ...(config.drive ?? {}), left: left as DriveMotor[],
          right: right as DriveMotor[], cart: sides[2] };
        break;
      }
      case '--holonomic': case '--wheel-diameter': case '--track':
      case '--wheel-rpm': case '--start':
        later.push(opt);
        break;
      case '--motor': {
        const m = mounted(parts[0]);
        if (!m || parts.length !== 2) { keep(opt, 'expected P[r]:CART'); break; }
        put(m.port, { kind: 'motor', reversed: m.reversed, cart: parts[1] }, opt);
        break;
      }
      case '--intake': case '--arm': case '--motor-fw':
        later.push(opt);
        break;
      case '--rotation': {
        const m = mounted(parts[0]);
        if (!m || parts.length < 2) { keep(opt, 'expected P[r]:track|strafe[:D[:X:Y]] or P:motorN'); break; }
        const [, source, diameter, x, y] = parts;
        put(m.port, { kind: 'rotation', reversed: m.reversed, source,
          ...(diameter !== undefined && { diameter }), ...(x !== undefined && { x }),
          ...(y !== undefined && { y }) }, opt);
        break;
      }
      case '--distance': {
        const p = +parts[0];
        if (!/^\d+$/.test(parts[0])) { keep(opt, 'expected P[:FACE[:X:Y]]'); break; }
        const [, face, x, y] = parts;
        put(p, { kind: 'distance', ...(face !== undefined && { face }),
          ...(x !== undefined && { x }), ...(y !== undefined && { y }) }, opt);
        break;
      }
      case '--radio': {
        if (!/^\d+$/.test(parts[0])) { keep(opt, 'expected P[:partner]'); break; }
        put(+parts[0], { kind: 'radio', partner: parts[1] === 'partner' }, opt);
        break;
      }
      case '--field-controller': {
        const [p, ...team] = value.split(':');
        if (!/^\d+$/.test(p)) { keep(opt, 'expected P[:TEAM]'); break; }
        put(+p, { kind: 'field-controller', ...(team.length && { team: team.join(':') }) }, opt);
        break;
      }
      case '--adi': {
        const i = value.indexOf(':');
        const p = i < 0 ? value : value.slice(0, i);
        if (!/^\d+$/.test(p)) { keep(opt, 'expected P:A=KIND,...'); break; }
        put(+p, { kind: 'adi', wiring: i < 0 ? '' : value.slice(i + 1) }, opt);
        break;
      }
      default: {
        const kind = name.slice(2);
        if ((SIMPLE_KINDS as readonly string[]).includes(kind)) {
          if (!/^\d+$/.test(value)) { keep(opt, 'expected a port'); break; }
          put(+value, { kind: kind as Kind }, opt);
        } else {
          keep(opt);
        }
      }
    }
  }

  for (const opt of later) {
    const [name, value = ''] = opt;
    const parts = value.split(':');
    const motorAt = (p: string) => {
      const d = config.ports[+p];
      return /^\d+$/.test(p) && d?.kind === 'motor' ? d : undefined;
    };
    if (name === '--intake') {
      const m = motorAt(parts[0]);
      if (!m) { keep(opt, '--intake P must be one of the --motor ports'); continue; }
      m.intake = true;
      if (parts[1] !== undefined) m.intakeCap = parts[1];
    } else if (name === '--arm') {
      const m = motorAt(parts[0]);
      if (!m) { keep(opt, `put a --motor on port ${parts[0]} first`); continue; }
      m.arm = parts.slice(1).join(':');
    } else if (name === '--motor-fw') {
      if (value === 'all') { config.motorFwAll = true; continue; }
      const m = motorAt(value);
      if (!m) { keep(opt); continue; }            // a drive motor's: kept as written
      m.firmware = true;
    } else if (config.drive) {
      const key = ({ '--holonomic': 'holonomic', '--wheel-diameter': 'wheelDiameter',
        '--track': 'track', '--wheel-rpm': 'wheelRpm', '--start': 'start' } as const)[name]!;
      config.drive[key] = value;
    } else {
      keep(opt, 'needs --drive');
    }
  }
  return { config, issues };
}

// ------------------------------------------------------------ serializing

/** `--opt value`, or `--opt=value` when the value looks like an option
 *  (argparse would take `--start -36:-60:0` for two options). */
function opt(name: string, value?: string): string {
  if (value === undefined) return name;
  return value.startsWith('-') ? `${name}=${value}` : `${name} ${value}`;
}

const portTok = (port: number, reversed?: boolean) => `${port}${reversed ? 'r' : ''}`;

/** The option(s) for one device, as one line. */
export function deviceArgs(port: number, d: Device): string {
  switch (d.kind) {
    case 'motor': {
      const out = [opt('--motor', `${portTok(port, d.reversed)}:${d.cart || 'green'}`)];
      if (d.intake) out.push(opt('--intake', d.intakeCap ? `${port}:${d.intakeCap}` : `${port}`));
      if (d.arm) out.push(opt('--arm', `${port}:${d.arm}`));
      if (d.firmware) out.push(opt('--motor-fw', `${port}`));
      return out.join(' ');
    }
    case 'rotation': {
      const src = d.source || 'track';
      const parts = [portTok(port, src.startsWith('motor') ? false : d.reversed), src];
      if (!src.startsWith('motor')) {
        const hasXY = !!(d.x || d.y);
        if (d.diameter || hasXY) parts.push(d.diameter || '2.75');
        if (hasXY) parts.push(d.x || '0', d.y || '0');
      }
      return opt('--rotation', parts.join(':'));
    }
    case 'distance': {
      const parts = [`${port}`];
      const hasXY = !!(d.x || d.y);
      if (d.face || hasXY) parts.push(d.face || 'front');
      if (hasXY) parts.push(d.x || '0', d.y || '0');
      return opt('--distance', parts.join(':'));
    }
    case 'radio':
      return opt('--radio', d.partner ? `${port}:partner` : `${port}`);
    case 'field-controller':
      return opt('--field-controller', d.team ? `${port}:${d.team}` : `${port}`);
    case 'adi':
      return opt('--adi', `${port}:${d.wiring ?? ''}`);
    default:
      return opt(`--${d.kind}`, `${port}`);
  }
}

export function serialize(config: RobotConfig): string {
  const lines: string[] = config.header.map(h => (h ? `# ${h}` : '#'));
  for (const inc of config.includes) lines.push(`@${inc.ref}`);
  const dr = config.drive;
  if (dr) {
    const side = (ms: DriveMotor[]) => ms.map(m => portTok(m.port, m.reversed)).join(',');
    const first = [opt('--drive', `${side(dr.left)}:${side(dr.right)}:${dr.cart}`)];
    if (dr.holonomic) first.push(opt('--holonomic', dr.holonomic));
    if (dr.wheelRpm) first.push(opt('--wheel-rpm', dr.wheelRpm));
    lines.push(first.join(' '));
    const geom: string[] = [];
    if (dr.wheelDiameter) geom.push(opt('--wheel-diameter', dr.wheelDiameter));
    if (dr.track) geom.push(opt('--track', dr.track));
    if (dr.start) geom.push(opt('--start', dr.start));
    if (geom.length) lines.push(geom.join(' '));
  }
  for (const port of Object.keys(config.ports).map(Number).sort((a, b) => a - b)) {
    lines.push(deviceArgs(port, config.ports[port]));
  }
  if (config.motorFwAll) lines.push('--motor-fw all');
  for (const o of config.extra) {
    lines.push(o[0] === '@' ? `@${o[1]}` : o.length > 1 ? opt(o[0], o[1]) : o[0]);
  }
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------ the port map

/** Every port a config uses -> a short label. */
export function usedPorts(config: RobotConfig): Record<number, string> {
  const out: Record<number, string> = {};
  const dr = config.drive;
  if (dr) {
    dr.left.forEach((m, i) => (out[m.port] = `Drive L${i + 1}`));
    dr.right.forEach((m, i) => (out[m.port] = `Drive R${i + 1}`));
  }
  for (const [p, d] of Object.entries(config.ports)) out[+p] = label(d);
  return out;
}

export function label(d: Device): string {
  switch (d.kind) {
    case 'motor': return d.intake ? 'Intake' : d.arm ? 'Arm' : 'Motor';
    case 'rotation': return d.source?.startsWith('motor') ? 'Rotation (shaft)' :
      d.source === 'strafe' ? 'Tracker (side)' : 'Tracker (fwd)';
    case 'adi': return '3-Wire';
    default: return KIND_LABELS[d.kind] ?? d.kind;
  }
}

function adiIssues(port: number, wiring: string, motors: Set<number>): Issue[] {
  const out: Issue[] = [];
  const used = new Set<number>();
  for (const item of wiring.split(',').filter(Boolean)) {
    const [letter, spec = ''] = item.split('=');
    const [kind, shaft] = spec.split(':');
    const i = ADI_LETTERS.indexOf(letter?.toUpperCase() as typeof ADI_LETTERS[number]);
    const err = (message: string) => out.push({ port, severity: 'error', message: `3-wire ${item}: ${message}` });
    if (i < 0 || !(ADI_KINDS as readonly string[]).includes(kind)) { err(`use A..H=${ADI_KINDS.join('|')}`); continue; }
    if (ADI_SHAFT.includes(kind) !== (shaft !== undefined)) { err('pot and potv2 take the motor port they sit on (A=pot:7); nothing else takes one'); continue; }
    if (shaft !== undefined && !motors.has(+shaft)) out.push({ port, severity: 'warning', message: `3-wire ${item}: no motor on port ${shaft}` });
    const paired = ADI_PAIRED.includes(kind);
    if (paired && i % 2) { err(`${kind} goes on A, C, E or G (it uses the next port too)`); continue; }
    for (const q of paired ? [i, i + 1] : [i]) {
      if (used.has(q)) err(`port ${ADI_LETTERS[q]} is already wired`);
      used.add(q);
    }
  }
  return out;
}

/** The checks robot.py makes before it starts, as issues on ports. */
export function validate(config: RobotConfig): Issue[] {
  const issues: Issue[] = [];
  const err = (message: string, port?: number) => issues.push({ port, severity: 'error', message });
  const warn = (message: string, port?: number) => issues.push({ port, severity: 'warning', message });
  const owner = new Map<number, string>();
  const claim = (port: number, what: string, kind?: Kind) => {
    if (!(port >= 1 && port <= SMART_PORTS) && !(port === ADI_PORT && kind === 'adi')) {
      err(`${what}: port ${port} is not a smart port 1..21`, port);
    } else if (owner.has(port)) {
      err(`port ${port}: ${owner.get(port)} and ${what} are both on it`, port);
    } else {
      owner.set(port, what);
    }
  };
  for (const inc of config.includes) {
    for (const [p, what] of Object.entries(inc.ports)) owner.set(+p, `${what} (from @${inc.ref})`);
  }

  const dr = config.drive;
  const motors = new Set<number>();
  if (dr) {
    dr.left.forEach(m => { claim(m.port, 'a drive motor'); motors.add(m.port); });
    dr.right.forEach(m => { claim(m.port, 'a drive motor'); motors.add(m.port); });
    if (!dr.left.length || dr.left.length !== dr.right.length) err('the drive needs the same number of motors on each side (at least one)');
    if (!(CARTRIDGES as readonly string[]).includes(dr.cart)) err(`drive cartridge must be one of ${CARTRIDGES.join(', ')}`);
    if (dr.holonomic && !['x', 'mecanum'].includes(dr.holonomic)) err('holonomic is x or mecanum');
    if (dr.holonomic && !(dr.left.length === 2 && dr.right.length === 2)) err('a holonomic drive needs two motors a side (front, back)');
    const num = (v: string | undefined, lo: number, hi: number, what: string) => {
      if (v !== undefined && v !== '' && !(+v >= lo && +v <= hi)) err(`${what} must be ${lo}..${hi}`);
    };
    num(dr.wheelDiameter, 0.5, 10, 'wheel diameter (in)');
    num(dr.track, 4, 30, 'track width (in)');
    num(dr.wheelRpm, 10, 2000, 'wheel rpm');
    if (dr.start && !/^-?[\d.]+:-?[\d.]+:-?[\d.]+$/.test(dr.start)) err('start pose is X:Y:HEADING');
  }

  const ports = Object.entries(config.ports).map(([p, d]) => [+p, d] as const);
  for (const [p, d] of ports) {
    claim(p, KIND_LABELS[d.kind] ?? d.kind, d.kind);
    if (d.kind === 'motor') motors.add(p);
  }
  let radios = 0, controllers = 0, intakes = 0;
  for (const [p, d] of ports) {
    switch (d.kind) {
      case 'motor':
        if (!(CARTRIDGES as readonly string[]).includes(d.cart ?? '')) err(`cartridge must be one of ${CARTRIDGES.join(', ')}`, p);
        if (d.intake) {
          intakes++;
          if (!dr) err('an intake needs a drive (it picks blocks up in front of the robot)', p);
          if (d.intakeCap && !(Number.isInteger(+d.intakeCap) && +d.intakeCap >= 1)) err('intake capacity must be a whole number, at least 1', p);
        }
        if (d.arm) {
          const n = d.arm.split(':');
          if (!(n.length === 3 || n.length === 6) || n.some(v => v === '' || !isFinite(+v))) err('arm is RATIO:LEN:KG[:START:LO:HI]', p);
        }
        break;
      case 'rotation': {
        const src = d.source ?? '';
        if (/^motor\d+$/.test(src)) {
          if (!motors.has(+src.slice(5))) warn(`no motor on port ${src.slice(5)} for this sensor's shaft`, p);
          if (d.reversed) err('a rotation sensor on a motor shaft is not written reversed', p);
        } else if (src === 'track' || src === 'strafe') {
          if (d.diameter !== undefined && d.diameter !== '' && !(+d.diameter > 0)) err('wheel diameter must be positive', p);
          for (const v of [d.x, d.y]) if (v !== undefined && v !== '' && !isFinite(+v)) err('offsets are numbers (inches)', p);
        } else {
          err('rotation source is track, strafe or motorN', p);
        }
        break;
      }
      case 'distance':
        if (d.face && !DISTANCE_FACES.includes(d.face) && !isFinite(+d.face)) err('face is front, right, back, left or degrees', p);
        for (const v of [d.x, d.y]) if (v !== undefined && v !== '' && !isFinite(+v)) err('offsets are numbers (inches)', p);
        break;
      case 'radio': radios++; break;
      case 'controller': controllers++; break;
      case 'field-controller':
        if (d.team && (d.team.length > 10 || !/^[\x20-\x7e]*$/.test(d.team))) err('team is up to 10 ASCII characters', p);
        break;
      case 'adi':
        issues.push(...adiIssues(p, d.wiring ?? '', motors));
        break;
    }
  }
  if (intakes > 1) err('only one motor can be the intake');
  if (radios > 1) warn('more than one radio: the sim uses the last one');
  if (radios && controllers) warn('a radio replaces the tethered controller');
  const hasDevice = !!dr || ports.length > 0 || config.includes.some(i => Object.keys(i.ports).length || i.missing);
  if (!hasDevice) err('the robot needs at least one device');
  return issues;
}
