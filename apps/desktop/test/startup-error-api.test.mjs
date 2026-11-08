import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const entrySource = readFileSync(new URL('../main-entry.mjs', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');

test('reports entry startup errors with Electron dialog.showErrorBox', () => {
  assert.match(entrySource, /electron\.dialog\.showErrorBox\(/);
  assert.doesNotMatch(entrySource, /electron\.app\.showErrorBox\(/);
});

test('reports main startup errors with Electron dialog.showErrorBox', () => {
  assert.match(mainSource, /dialog\??\.showErrorBox\(/);
  assert.doesNotMatch(mainSource, /app\.showErrorBox\(/);
});
