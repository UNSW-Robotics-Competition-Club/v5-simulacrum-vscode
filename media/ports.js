// The port map editor (webview side). The host (src/panels/portsPanel.ts)
// owns the file: it sends the config as a port map plus its issues and the
// file text, and gets every edit back as {type: 'change', config}.
// The config shape is RobotConfig in src/robotConfig.ts.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  const SMART = 21, ADI = 22;
  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const ADI_KINDS = ['bumper', 'limit', 'encoder', 'sonar', 'piston', 'gyro', 'pot', 'potv2', 'line', 'light', 'accel'];
  const ADI_PAIRED = ['encoder', 'sonar'];
  const ADI_SHAFT = ['pot', 'potv2'];
  const ADI_LABELS = {
    bumper: 'Bumper switch', limit: 'Limit switch', encoder: 'Optical shaft encoder (2 ports)',
    sonar: 'Ultrasonic rangefinder (2 ports)', piston: 'Pneumatic piston (digital out)', gyro: 'Gyro',
    pot: 'Potentiometer (on a motor shaft)', potv2: 'Potentiometer V2 (on a motor shaft)',
    line: 'Line tracker', light: 'Light sensor', accel: 'Accelerometer',
  };
  const CARTS = [['red', 'red (100 rpm)'], ['green', 'green (200 rpm)'], ['blue', 'blue (600 rpm)'], ['5.5w', '5.5 W (200 rpm)']];
  // what a smart port can hold, in the menu's order
  const KINDS = [
    ['', '(empty)'],
    ['drive-left', 'Drive motor, left side'], ['drive-right', 'Drive motor, right side'],
    ['motor', 'Motor'],
    ['imu', 'Inertial Sensor'], ['rotation', 'Rotation Sensor'], ['distance', 'Distance Sensor'],
    ['optical', 'Optical Sensor'], ['gps', 'GPS Sensor'], ['aivision', 'AI Vision Sensor'],
    ['vision', 'Vision Sensor (legacy)'],
    ['radio', 'VEXnet Radio (wireless controller)'], ['controller', 'Controller (tethered)'],
    ['adi', '3-Wire Expander'],
    ['magnet', 'Electromagnet'], ['tower', 'Light Tower'], ['pneumatic', 'CTE Pneumatics'], ['led', 'LED'],
    ['field-controller', 'Field-control link'],
  ];
  const KIND_NAME = Object.fromEntries(KINDS);
  const CATEGORY = {
    'drive-left': 'drive', 'drive-right': 'drive', motor: 'motor',
    imu: 'sensor', rotation: 'sensor', distance: 'sensor', optical: 'sensor', gps: 'sensor',
    aivision: 'sensor', vision: 'sensor', radio: 'radio', controller: 'radio', 'field-controller': 'radio',
    adi: 'adi', magnet: 'other', tower: 'other', pneumatic: 'other', led: 'other',
  };
  const SHORT = {
    motor: 'Motor', imu: 'IMU', rotation: 'Rotation', distance: 'Distance', optical: 'Optical', gps: 'GPS',
    aivision: 'AI Vision', vision: 'Vision', radio: 'Radio', controller: 'Controller', adi: '3-Wire',
    magnet: 'Magnet', tower: 'Tower', pneumatic: 'Pneumatics', led: 'LED', 'field-controller': 'Field link',
  };

  let state = { config: null, issues: [], text: '', file: null, name: '', dirty: false, presets: [], active: false };
  let selected = (vscode.getState() || {}).selected || 1;

  // ------------------------------------------------------------ helpers
  const $ = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : String(kid));
    return e;
  };
  const cfg = () => state.config;
  const changed = (rerender = true) => {
    state.dirty = true;
    vscode.postMessage({ type: 'change', config: cfg() });
    if (rerender) render();
  };

  /** Who is on a port: {kind, side?, index?, dev?, include?}. */
  function occupant(port) {
    const c = cfg();
    const d = c.drive;
    if (d) {
      for (const side of ['left', 'right']) {
        const i = d[side].findIndex(m => m.port === port);
        if (i >= 0) return { kind: `drive-${side}`, side, index: i, motor: d[side][i] };
      }
    }
    if (c.ports[port]) return { kind: c.ports[port].kind, dev: c.ports[port] };
    for (const inc of c.includes) {
      if (inc.ports[port]) return { kind: 'include', label: inc.ports[port], ref: inc.ref };
    }
    return null;
  }

  function tileLabel(o) {
    if (!o) return '';
    if (o.kind === 'include') return o.label;
    if (o.side) return `Drive ${o.side === 'left' ? 'L' : 'R'}${o.index + 1}`;
    const d = o.dev;
    if (d.kind === 'motor') return d.intake ? 'Intake' : d.arm ? 'Arm' : 'Motor';
    if (d.kind === 'rotation') return (d.source || '').startsWith('motor') ? `Rot. ${d.source.slice(5)}` :
      d.source === 'strafe' ? 'Tracker ↔' : 'Tracker ↕';
    if (d.kind === 'distance') return `Dist. ${d.face || 'front'}`;
    return SHORT[d.kind] || d.kind;
  }

  function tileDetail(o) {
    if (!o || o.kind === 'include') return o ? `from @${o.ref}` : '';
    if (o.side) return `${cfg().drive.cart}${o.motor.reversed ? ' · rev' : ''}`;
    const d = o.dev;
    if (d.kind === 'motor') return `${d.cart}${d.reversed ? ' · rev' : ''}${d.firmware ? ' · fw' : ''}`;
    if (d.kind === 'radio' && d.partner) return '+ partner';
    if (d.kind === 'adi') return adiSummary(d.wiring);
    return '';
  }

  /** Take whatever is on the port off it. */
  function clearPort(port) {
    const c = cfg();
    const o = occupant(port);
    if (!o || o.kind === 'include') return;
    if (o.side) {
      c.drive[o.side].splice(o.index, 1);
      if (!c.drive.left.length && !c.drive.right.length) delete c.drive;
    } else {
      delete c.ports[port];
    }
  }

  function defaults(kind) {
    switch (kind) {
      case 'motor': return { kind, cart: 'green', reversed: false };
      case 'rotation': return { kind, source: 'track', reversed: false };
      case 'radio': return { kind, partner: false };
      case 'adi': return { kind, wiring: '' };
      default: return { kind };
    }
  }

  function setKind(port, kind) {
    const c = cfg();
    clearPort(port);
    if (kind === 'drive-left' || kind === 'drive-right') {
      if (!c.drive) c.drive = { left: [], right: [], cart: 'blue' };
      c.drive[kind.slice(6)].push({ port, reversed: false });
    } else if (kind) {
      c.ports[port] = defaults(kind);
    }
  }

  /** Swap what's on two ports (drag and drop, "move to"). */
  function swap(a, b) {
    if (a === b) return;
    const c = cfg();
    const oa = occupant(a), ob = occupant(b);
    if (oa?.kind === 'include' || ob?.kind === 'include') return;
    if (a === ADI || b === ADI) return;
    const take = (o, port) => o && (o.side ? { motor: o.motor, side: o.side, index: o.index } : { dev: c.ports[port] });
    const ta = take(oa, a), tb = take(ob, b);
    delete c.ports[a]; delete c.ports[b];
    const put = (t, port) => {
      if (!t) return;
      if (t.motor) t.motor.port = port;
      else c.ports[port] = t.dev;
    };
    put(ta, b); put(tb, a);
    // rotation sensors / pots that point at a moved motor follow it
    const moved = { [a]: b, [b]: a };
    for (const d of Object.values(c.ports)) {
      if (d.kind === 'rotation' && /^motor\d+$/.test(d.source || '') && moved[+d.source.slice(5)]) {
        d.source = `motor${moved[+d.source.slice(5)]}`;
      }
      if (d.kind === 'adi') d.wiring = remapShafts(d.wiring || '', moved);
    }
    selected = b;
  }

  // ------------------------------------------------------------ 3-wire
  function parseWiring(w) {
    const out = {};
    for (const item of (w || '').split(',').filter(Boolean)) {
      const [letter, spec = ''] = item.split('=');
      const [kind, shaft] = spec.split(':');
      out[letter.toUpperCase()] = { kind, shaft };
    }
    return out;
  }
  function wiringText(m) {
    return LETTERS.filter(l => m[l] && m[l].kind)
      .map(l => `${l}=${m[l].kind}${ADI_SHAFT.includes(m[l].kind) ? `:${m[l].shaft || ''}` : ''}`).join(',');
  }
  function remapShafts(w, moved) {
    const m = parseWiring(w);
    for (const l of LETTERS) if (m[l]?.shaft && moved[+m[l].shaft]) m[l].shaft = String(moved[+m[l].shaft]);
    return wiringText(m);
  }
  function adiSummary(w) {
    const m = parseWiring(w);
    const used = LETTERS.filter(l => m[l]);
    return used.length ? used.join('') : 'nothing wired';
  }

  // ------------------------------------------------------------ rendering
  function render() {
    if (!cfg()) return;
    renderToolbar();
    renderGrid();
    renderDrive();
    renderEditor();
    renderBottom();
    vscode.setState({ selected });
  }

  function renderToolbar() {
    const bar = document.getElementById('toolbar');
    const sel = $('select', { title: 'Open a preset', onchange: e => {
      const v = e.target.value;
      if (v === '__browse') vscode.postMessage({ type: 'open' });
      else if (v) vscode.postMessage({ type: 'open', file: v });
    } },
      $('option', { value: '' }, state.file ? `${state.name}${state.dirty ? ' ●' : ''}` : `untitled${state.dirty ? ' ●' : ''}`),
      ...state.presets.filter(p => p.file !== state.file).map(p => $('option', { value: p.file }, p.label)),
      $('option', { value: '__browse' }, 'Open another .args file...'));
    bar.replaceChildren(
      $('span', { class: 'title' }, 'Robot'), sel,
      state.active ? $('span', { class: 'badge', title: 'This is the v5sim.preset the simulator starts with' }, 'active') : null,
      $('span', { class: 'spacer' }),
      $('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'new' }) }, 'New'),
      $('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'openText' }), disabled: !state.file }, 'Open as text'),
      $('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'saveAs' }) }, 'Save as...'),
      $('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'save' }), disabled: !state.dirty && !!state.file }, 'Save'),
      $('button', { onclick: () => vscode.postMessage({ type: 'apply' }),
        title: 'Save, make this the simulator\'s robot (v5sim.preset) and (re)start the simulator' }, 'Apply & restart sim'));
  }

  function issuesFor(port) {
    return state.issues.filter(i => i.port === port);
  }

  function tile(port) {
    const o = occupant(port);
    const issues = issuesFor(port);
    const cls = ['tile', o ? `cat-${o.kind === 'include' ? 'include' : CATEGORY[o.kind] || 'other'}` : 'empty'];
    if (port === selected) cls.push('selected');
    if (issues.some(i => i.severity === 'error')) cls.push('error');
    else if (issues.length) cls.push('warning');
    const t = $('button', {
      class: cls.join(' '), title: issues.map(i => i.message).join('\n') || `Port ${port}`,
      draggable: port !== ADI && o && o.kind !== 'include' ? 'true' : 'false',
      onclick: () => { selected = port; render(); },
      ondragstart: e => e.dataTransfer.setData('text/plain', String(port)),
      ondragover: e => { if (port !== ADI) { e.preventDefault(); t.classList.add('drop'); } },
      ondragleave: () => t.classList.remove('drop'),
      ondrop: e => {
        e.preventDefault();
        const from = +e.dataTransfer.getData('text/plain');
        if (from && from !== port) { swap(from, port); changed(); }
      },
    },
      $('span', { class: 'num' }, port === ADI ? '3-wire' : port),
      $('span', { class: 'what' }, port === ADI ? 'Built-in A–H' : tileLabel(o) || 'empty'),
      $('span', { class: 'detail' }, port === ADI ? adiSummary(cfg().ports[ADI]?.wiring) : tileDetail(o)));
    return t;
  }

  function renderGrid() {
    const grid = document.getElementById('grid');
    grid.replaceChildren(
      $('div', { class: 'row-label' }, 'Smart ports'),
      $('div', { class: 'ports' }, ...Array.from({ length: SMART }, (_, i) => tile(i + 1))),
    );
    document.getElementById('adi22').replaceChildren(tile(ADI));
  }

  function field(label, input, hint) {
    return $('label', { class: 'field' }, $('span', {}, label), input, hint ? $('small', {}, hint) : null);
  }
  function text(value, onchange, attrs = {}) {
    return $('input', { type: 'text', value: value ?? '', ...attrs,
      onchange: e => onchange(e.target.value.trim()) });
  }
  function check(value, onchange) {
    return $('input', { type: 'checkbox', checked: !!value, onchange: e => onchange(e.target.checked) });
  }
  function select(value, opts, onchange) {
    return $('select', { onchange: e => onchange(e.target.value) },
      ...opts.map(([v, l]) => $('option', { value: v, selected: v === value }, l)));
  }
  const setOpt = (obj, key) => v => { if (v === '' || v === false) delete obj[key]; else obj[key] = v; changed(); };

  function renderDrive() {
    const box = document.getElementById('drive');
    const d = cfg().drive;
    if (!d) {
      box.replaceChildren($('div', { class: 'drive-empty' }, 'No drivetrain. ',
        $('button', { class: 'secondary', onclick: () => {
          cfg().drive = { left: [], right: [], cart: 'blue' };
          for (const [side, ports] of [['left', [1, 2, 3]], ['right', [4, 5, 6]]]) {
            for (const p of ports) if (!occupant(p)) cfg().drive[side].push({ port: p, reversed: false });
          }
          changed();
        } }, 'Add a 6-motor drive on 1–6')));
      return;
    }
    const sideText = ms => ms.map(m => `${m.port}${m.reversed ? 'r' : ''}`).join(',');
    const setSide = side => v => {
      const ms = v.split(',').map(s => s.trim()).filter(Boolean).map(s => /^(\d+)(r?)$/.exec(s));
      if (ms.some(m => !m)) { render(); return; }
      d[side] = ms.map(m => ({ port: +m[1], reversed: m[2] === 'r' }));
      changed();
    };
    const type = d.holonomic || '';
    box.replaceChildren(
      $('h3', {}, 'Drivetrain'),
      $('div', { class: 'fields' },
        field('Left motors', text(sideText(d.left), setSide('left')), 'front to back; r = reversed in code'),
        field('Right motors', text(sideText(d.right), setSide('right'))),
        field('Cartridge', select(d.cart, CARTS, v => { d.cart = v; changed(); })),
        field('Type', select(type, [['', 'Tank'], ['x', 'X-drive'], ['mecanum', 'Mecanum']], setOpt(d, 'holonomic'))),
        field('Wheel diameter (in)', text(d.wheelDiameter, setOpt(d, 'wheelDiameter'), { placeholder: '3.25' })),
        field('Track width (in)', text(d.track, setOpt(d, 'track'), { placeholder: '12' })),
        field('Wheel rpm', text(d.wheelRpm, setOpt(d, 'wheelRpm'), { placeholder: '¾ of the cartridge' })),
        field('Start X:Y:heading', text(d.start, setOpt(d, 'start'), { placeholder: '0:0:0' }), 'inches from centre, RW-Template frame'),
      ),
      $('label', { class: 'inline' }, check(cfg().motorFwAll, v => { cfg().motorFwAll = v; changed(); }),
        ' Every motor runs VEX\'s real motor firmware (--motor-fw all; ~⅓ CPU core each)'),
      $('button', { class: 'link', onclick: () => { delete cfg().drive; changed(); } }, 'Remove the drivetrain'));
  }

  function renderEditor() {
    const box = document.getElementById('editor');
    const port = selected;
    if (port === ADI) { box.replaceChildren(...adiEditor(ADI, 'The brain\'s 3-wire ports')); return; }
    const o = occupant(port);
    const head = $('h2', {}, `Port ${port}`);
    if (o?.kind === 'include') {
      box.replaceChildren(head, $('p', {}, `${o.label}, from the included preset @${o.ref}. `,
        'Edit that file to change it. A device of your own here would be a second one on the port, which the simulator refuses.'));
      return;
    }
    const kind = o ? o.kind : '';
    const free = Array.from({ length: SMART }, (_, i) => i + 1).filter(p => p !== port);
    const parts = [head,
      field('Device', select(kind, KINDS, v => { setKind(port, v); changed(); })),
    ];
    if (o) {
      parts.push(field('Move to port', select('', [['', '—'], ...free.map(p => {
        const other = occupant(p);
        return [String(p), `${p}${other ? ` (swap with ${tileLabel(other)})` : ''}`];
      })], v => { if (v) { swap(port, +v); changed(); } }), 'or drag the tile onto another port'));
    }
    if (o?.side) {
      const m = o.motor;
      parts.push(field('Reversed in code', check(m.reversed, v => { m.reversed = v; changed(); }),
        'the program sets this motor reversed (most do for one side)'),
        $('p', { class: 'hint' }, `Position ${o.index + 1} on the ${o.side} side. Cartridge and geometry are in Drivetrain.`));
    } else if (o) {
      parts.push(...deviceFields(port, o.dev));
    }
    for (const i of issuesFor(port)) parts.push($('p', { class: `issue ${i.severity}` }, i.message));
    box.replaceChildren(...parts);
  }

  function deviceFields(port, d) {
    const out = [];
    switch (d.kind) {
      case 'motor': {
        out.push(field('Cartridge', select(d.cart, CARTS, v => { d.cart = v; changed(); })),
          field('Reversed in code', check(d.reversed, setOpt(d, 'reversed'))),
          field('Intake', check(d.intake, v => { if (v) d.intake = true; else { delete d.intake; delete d.intakeCap; } changed(); }),
            'a front intake: forward picks blocks up, reverse ejects'));
        if (d.intake) out.push(field('Intake capacity', text(d.intakeCap, setOpt(d, 'intakeCap'), { placeholder: '6' })));
        const arm = d.arm ? d.arm.split(':') : null;
        out.push(field('Lifts an arm', check(!!arm, v => { if (v) d.arm = '5:10:1'; else delete d.arm; changed(); }),
          'gravity load on the motor'));
        if (arm) {
          const names = [['Gear ratio', '5'], ['Length to load (in)', '10'], ['Load (kg)', '1'],
            ['Start angle (°)', '-90'], ['Low stop (°)', '-90'], ['High stop (°)', '90']];
          const vals = names.map((_, i) => arm[i] ?? '');
          const setArm = i => v => {
            vals[i] = v;
            const trimmed = vals.slice(3).some(x => x !== '') ? vals.map((x, j) => x || names[j][1]) : vals.slice(0, 3);
            d.arm = trimmed.join(':');
            changed();
          };
          out.push($('div', { class: 'fields' }, ...names.map(([l, ph], i) =>
            field(l, text(vals[i], setArm(i), { placeholder: ph })))));
        }
        out.push(field('Real motor firmware', check(d.firmware, setOpt(d, 'firmware')),
          'runs VEX\'s own motor firmware in QEMU (~⅓ CPU core)'));
        break;
      }
      case 'rotation': {
        const src = d.source || 'track';
        const onMotor = src.startsWith('motor');
        out.push(field('Mounted on', select(onMotor ? 'motor' : src,
          [['track', 'Tracking wheel (forward)'], ['strafe', 'Tracking wheel (sideways)'], ['motor', 'A motor\'s shaft']],
          v => { d.source = v === 'motor' ? 'motor' + (motorPorts()[0] ?? 1) : v; if (v === 'motor') { delete d.reversed; delete d.diameter; delete d.x; delete d.y; } changed(); })));
        if (onMotor) {
          out.push(field('Motor port', select(src.slice(5), motorPorts().map(p => [String(p), String(p)]).concat(
            motorPorts().includes(+src.slice(5)) ? [] : [[src.slice(5), `${src.slice(5)} (no motor)`]]),
            v => { d.source = `motor${v}`; changed(); })));
        } else {
          out.push(field('Reads reversed', check(d.reversed, setOpt(d, 'reversed'))),
            $('div', { class: 'fields' },
              field('Wheel diameter (in)', text(d.diameter, setOpt(d, 'diameter'), { placeholder: '2.75' })),
              field('X offset (in, right)', text(d.x, setOpt(d, 'x'), { placeholder: '0' })),
              field('Y offset (in, forward)', text(d.y, setOpt(d, 'y'), { placeholder: '0' }))));
        }
        break;
      }
      case 'distance': {
        const face = d.face || 'front';
        const named = ['front', 'right', 'back', 'left'].includes(face);
        out.push(field('Facing', select(named ? face : 'deg',
          [['front', 'Front'], ['right', 'Right'], ['back', 'Back'], ['left', 'Left'], ['deg', 'Angle...']],
          v => { if (v === 'deg') d.face = '45'; else if (v === 'front' && !d.x && !d.y) delete d.face; else d.face = v; changed(); })));
        if (!named) out.push(field('Angle (° clockwise from front)', text(face, setOpt(d, 'face'))));
        out.push($('div', { class: 'fields' },
          field('X offset (in, right)', text(d.x, setOpt(d, 'x'), { placeholder: 'on that face' })),
          field('Y offset (in, forward)', text(d.y, setOpt(d, 'y'), { placeholder: 'on that face' }))));
        break;
      }
      case 'radio':
        out.push(field('Partner controller', check(d.partner, v => { d.partner = v; changed(); }), 'a second controller, driven from the field view'));
        break;
      case 'field-controller':
        out.push(field('Team', text(d.team, setOpt(d, 'team'), { placeholder: `SIM${port}`, maxlength: '10' })));
        break;
      case 'adi':
        out.push(...adiEditor(port, '3-Wire Expander'));
        break;
    }
    return out;
  }

  function motorPorts() {
    const c = cfg();
    const ps = Object.entries(c.ports).filter(([, d]) => d.kind === 'motor').map(([p]) => +p);
    if (c.drive) ps.push(...c.drive.left.map(m => m.port), ...c.drive.right.map(m => m.port));
    return ps.sort((a, b) => a - b);
  }

  function adiEditor(port, title) {
    const c = cfg();
    const dev = c.ports[port] || { kind: 'adi', wiring: '' };
    const m = parseWiring(dev.wiring);
    const save = () => {
      dev.wiring = wiringText(m);
      if (port === ADI && !dev.wiring) delete c.ports[ADI]; else c.ports[port] = dev;
      changed();
    };
    const rows = LETTERS.map((l, i) => {
      const prev = i % 2 ? m[LETTERS[i - 1]] : null;
      if (prev && ADI_PAIRED.includes(prev.kind)) {
        return $('div', { class: 'adi-row' }, $('b', {}, l), $('span', { class: 'hint' }, `used by ${LETTERS[i - 1]} (${prev.kind})`));
      }
      const cur = m[l] || { kind: '' };
      const opts = [['', '—'], ...ADI_KINDS.filter(k => !ADI_PAIRED.includes(k) || i % 2 === 0).map(k => [k, ADI_LABELS[k]])];
      const row = $('div', { class: 'adi-row' }, $('b', {}, l),
        select(cur.kind, opts, v => {
          if (v) m[l] = { kind: v, shaft: ADI_SHAFT.includes(v) ? String(motorPorts()[0] ?? 1) : undefined };
          else delete m[l];
          if (ADI_PAIRED.includes(v)) delete m[LETTERS[i + 1]];
          save();
        }));
      if (ADI_SHAFT.includes(cur.kind)) {
        row.append($('span', {}, ' on motor '), select(cur.shaft || '', motorPorts().map(p => [String(p), String(p)]).concat(
          motorPorts().includes(+cur.shaft) ? [] : [[cur.shaft || '', `${cur.shaft || '?'} (no motor)`]]),
          v => { cur.shaft = v; save(); }));
      }
      return row;
    });
    const out = [$('h3', {}, title), ...rows];
    if (port === ADI) {
      out.unshift($('h2', {}, 'Built-in 3-wire ports'));
      out.push($('p', { class: 'hint' }, 'The brain\'s own A–H ports (written --adi 22:...).'));
      for (const i of issuesFor(ADI)) out.push($('p', { class: `issue ${i.severity}` }, i.message));
    }
    return out;
  }

  function renderBottom() {
    const box = document.getElementById('bottom');
    const general = state.issues.filter(i => i.port == null);
    const extraText = cfg().extra.map(o => o[0] === '@' ? `@${o[1]}` : o.length > 1 ? `${o[0]} ${o[1]}` : o[0]).join('\n');
    const errors = state.issues.filter(i => i.severity === 'error').length;
    box.replaceChildren(
      general.length ? $('div', { class: 'issues' }, ...general.map(i => $('p', { class: `issue ${i.severity}` }, i.message))) : null,
      $('p', { class: 'status' }, errors ? `${errors} problem(s): the simulator won't start with this robot.` : 'The simulator can start with this robot.'),
      $('details', {}, $('summary', {}, 'Other options (field, match, physics...)'),
        $('p', { class: 'hint' }, 'One option per line, as in the file: e.g. --blocks random:24:7, --match 20, --physics mujoco, --battery 80. See SIMULATOR.md section 4.'),
        $('textarea', { rows: '6', spellcheck: 'false',
          onchange: e => vscode.postMessage({ type: 'extraText', config: cfg(), text: e.target.value }) }, extraText)),
      $('details', {}, $('summary', {}, `File preview (${state.name})`), $('pre', {}, state.text)),
    );
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'load' || m.type === 'update') {
      const keep = m.type === 'update' ? state.config : m.config;
      state = { ...m, config: keep };
      render();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
