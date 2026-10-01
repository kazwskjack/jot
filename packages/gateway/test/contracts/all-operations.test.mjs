import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildServer } from '../../src/server.ts';

test('every OpenAPI operation is registered by the backend router', async () => {
  const spec = JSON.parse(readFileSync(new URL('../../contracts/openapi.json', import.meta.url), 'utf8'));
  const directory = mkdtempSync(join(tmpdir(), 'ga-routes-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'] });
  try {
    const missing = [];
    let operations = 0;
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        if (!item[method]) continue;
        operations += 1;
        const url = path.replace(/\{([^}]+)\}/g, ':$1');
        if (!service.app.hasRoute({ method: method.toUpperCase(), url })) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    assert.equal(operations, 33);
    assert.deepEqual(missing, []);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
