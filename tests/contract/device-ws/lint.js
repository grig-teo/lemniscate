#!/usr/bin/env node
// CI lint for the device-WS shared contract fixtures.
//
// Run: node tests/contract/device-ws/lint.js
//
// Fails when:
//   1. A file in index.json is missing from the directory.
//   2. A .json fixture in the directory is not listed in index.json
//      (a new command was added but the manifest was not updated).
//   3. A fixture is malformed (missing _comment / direction, or
//      missing `frame` for wire messages / `closeCode` for close codes).
//
// This guards against silent divergence: every consumer test iterates
// index.json, so an unlisted fixture would be invisible to CI.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
const errors = [];

const onDisk = new Set(
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json'),
);
const listed = new Set(index.fixtures);

// 1. listed but missing
for (const name of index.fixtures) {
  if (!onDisk.has(name)) {
    errors.push(`index.json lists "${name}" but the file is missing`);
  }
}
// 2. on disk but not listed
for (const name of onDisk) {
  if (!listed.has(name)) {
    errors.push(`"${name}" exists on disk but is not in index.json`);
  }
}
// 3. structure validation
for (const name of index.fixtures) {
  const fixture = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  if (typeof fixture._comment !== 'string') {
    errors.push(`${name}: missing "_comment" string`);
  }
  if (typeof fixture.direction !== 'string') {
    errors.push(`${name}: missing "direction" string`);
    continue;
  }
  if (fixture.direction === 'close') {
    if (typeof fixture.closeCode !== 'number') {
      errors.push(`${name}: direction "close" requires a numeric "closeCode"`);
    }
  } else if (!fixture.frame || typeof fixture.frame !== 'object') {
    errors.push(`${name}: direction "${fixture.direction}" requires a "frame" object`);
  }
}

if (errors.length > 0) {
  for (const err of errors) console.error(`  ✗ ${err}`);
  console.error(`\n${errors.length} fixture-lint error(s) in tests/contract/device-ws/`);
  process.exit(1);
}

console.log(`  ✓ ${index.fixtures.length} fixtures validated (index.json matches disk)`);
