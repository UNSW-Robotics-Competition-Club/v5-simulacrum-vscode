// Adding v5gdb to a project (Debug on Sim's "Add v5gdb"): the commands that
// add the dependency, and where its install call and import go in the
// source, as v5gdb's setup pages show them. The edit itself is shown to
// the user as a preview before anything is written. No VS Code imports.

export const V5GDB_DEPOT = 'https://raw.githubusercontent.com/vexide/v5gdb/depot/preview.json';
export const V5GDB_WIKI = {
  vexide: 'https://github.com/vexide/v5gdb/wiki/Installation-and-setup-(Rust)',
  pros: 'https://github.com/vexide/v5gdb/wiki/Installation-and-setup-(Cpp)',
};

/** Shell commands that add v5gdb to the project (run in its folder). */
export function addDependencyCommands(framework: 'vexide' | 'pros', depotAdded: boolean): string[] {
  if (framework === 'vexide') return ['cargo add v5gdb'];
  return [...(depotAdded ? [] : [`pros c add-depot v5gdb ${V5GDB_DEPOT}`]), 'pros c apply v5gdb'];
}

/** The upgrade command for a framework older than v5gdb supports. */
export function upgradeCommand(framework: 'vexide' | 'pros'): string {
  return framework === 'vexide' ? 'cargo update -p vexide (with vexide = "0.9.0-alpha.1" or later in Cargo.toml)' : 'pros c upgrade';
}

export interface Insertion { line: number; text: string }

/** Where the install call and the import go in the program's entry file
 *  (main.rs: the #[vexide::main] function; main.cpp: initialize()), or
 *  undefined when that function isn't found (the caller shows the lines
 *  to paste instead). Lines are 0-based; insert before `line`. */
export function v5gdbInsertions(framework: 'vexide' | 'pros', source: string): Insertion[] | undefined {
  const lines = source.split(/\r?\n/);
  if (framework === 'vexide') {
    if (lines.some(l => /\bv5gdb::install\b/.test(l))) return [];
    const attr = lines.findIndex(l => /^\s*#\[vexide::main/.test(l));
    if (attr < 0) return undefined;
    const body = openingBrace(lines, attr);
    if (body < 0) return undefined;
    const indent = indentOf(lines[body + 1]) || '    ';
    const lastUse = lastIndex(lines.slice(0, attr), l => /^\s*use\s/.test(l));
    return [
      { line: lastUse + 1, text: 'use v5gdb::prelude::*;' },
      { line: body + 1, text: `${indent}v5gdb::install(V5Debugger::stdio().stop_motors_on_break(true));` },
    ];
  }
  if (lines.some(l => /\bv5gdb::install\b/.test(l))) return [];
  const fn = lines.findIndex(l => /^\s*void\s+initialize\s*\(\s*(void)?\s*\)/.test(l));
  if (fn < 0) return undefined;
  const body = openingBrace(lines, fn);
  if (body < 0) return undefined;
  const indent = indentOf(lines[body + 1]) || '  ';
  const lastInclude = lastIndex(lines.slice(0, fn), l => /^\s*#\s*include\s/.test(l));
  return [
    { line: lastInclude + 1, text: '#include "v5gdb/v5gdb.h"' },
    { line: body + 1, text: `${indent}v5gdb::install({.stop_motors_on_break = true});` },
  ];
}

/** The line holding the function's opening brace, from its signature on. */
function openingBrace(lines: string[], from: number): number {
  for (let i = from; i < Math.min(lines.length, from + 6); i++) {
    if (lines[i].includes('{')) return i;
  }
  return -1;
}

function indentOf(line: string | undefined): string {
  return line?.match(/^[ \t]*/)?.[0] ?? '';
}

function lastIndex<T>(xs: T[], p: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (p(xs[i])) return i;
  return -1;
}

/** The lines to paste when the entry function isn't found. */
export function installSnippet(framework: 'vexide' | 'pros'): string {
  return framework === 'vexide'
    ? 'use v5gdb::prelude::*;\n// first line of your #[vexide::main] function:\nv5gdb::install(V5Debugger::stdio().stop_motors_on_break(true));'
    : '#include "v5gdb/v5gdb.h"\n// first line of initialize():\nv5gdb::install({.stop_motors_on_break = true});';
}
