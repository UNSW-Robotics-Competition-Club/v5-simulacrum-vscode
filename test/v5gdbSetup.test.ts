import assert from 'node:assert/strict';
import { test } from 'node:test';

import { V5GDB_DEPOT, addDependencyCommands, v5gdbInsertions } from '../src/debug/v5gdbSetup';

/** Applies insertions as VS Code would (each before its 0-based line, from
 *  the bottom up so earlier lines keep their numbers). */
function apply(source: string, ins: { line: number; text: string }[]): string {
  const lines = source.split('\n');
  for (const i of [...ins].sort((a, b) => b.line - a.line)) lines.splice(i.line, 0, i.text);
  return lines.join('\n');
}

test('vexide: the import after the last use, the install call first in #[vexide::main]', () => {
  const src = 'use vexide::prelude::*;\nuse core::time::Duration;\n\n#[vexide::main]\nasync fn main(peripherals: Peripherals) {\n    println!("hi");\n}\n';
  assert.equal(apply(src, v5gdbInsertions('vexide', src)!),
    'use vexide::prelude::*;\nuse core::time::Duration;\nuse v5gdb::prelude::*;\n\n#[vexide::main]\nasync fn main(peripherals: Peripherals) {\n' +
    '    v5gdb::install(V5Debugger::stdio().stop_motors_on_break(true));\n    println!("hi");\n}\n');
  // the brace on its own line, attributes with arguments
  const allman = '#[vexide::main(banner(enabled = false))]\nasync fn main(p: Peripherals)\n{\n\tloop {}\n}';
  const out = apply(allman, v5gdbInsertions('vexide', allman)!);
  assert.match(out, /^use v5gdb::prelude::\*;\n/);
  assert.match(out, /\{\n\tv5gdb::install/);
});

test('PROS: the include after the last include, the install call first in initialize()', () => {
  const src = '#include "main.h"\n#include "lemlib/api.hpp"\n\nvoid initialize() {\n  pros::lcd::initialize();\n}\n';
  assert.equal(apply(src, v5gdbInsertions('pros', src)!),
    '#include "main.h"\n#include "lemlib/api.hpp"\n#include "v5gdb/v5gdb.h"\n\nvoid initialize() {\n' +
    '  v5gdb::install({.stop_motors_on_break = true});\n  pros::lcd::initialize();\n}\n');
});

test('already installed: nothing to add; no entry function: undefined (paste it yourself)', () => {
  assert.deepEqual(v5gdbInsertions('pros', 'void initialize() {\n  v5gdb::install({});\n}'), []);
  assert.deepEqual(v5gdbInsertions('vexide', '#[vexide::main]\nasync fn main(p: Peripherals) {\n    v5gdb::install(V5Debugger::stdio());\n}'), []);
  assert.equal(v5gdbInsertions('pros', 'int main() {}'), undefined);
  assert.equal(v5gdbInsertions('vexide', 'fn main() {}'), undefined);
});

test('the dependency: cargo add, or the PROS depot (once) and apply', () => {
  assert.deepEqual(addDependencyCommands('vexide', false), ['cargo add v5gdb']);
  assert.deepEqual(addDependencyCommands('pros', false), [`pros c add-depot v5gdb ${V5GDB_DEPOT}`, 'pros c apply v5gdb']);
  assert.deepEqual(addDependencyCommands('pros', true), ['pros c apply v5gdb']);
});
