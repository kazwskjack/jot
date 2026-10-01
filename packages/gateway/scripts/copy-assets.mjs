import { cpSync, mkdirSync } from 'node:fs';

mkdirSync(new URL('../dist/src/db/', import.meta.url), { recursive: true });
cpSync(new URL('../src/db/schema.sql', import.meta.url), new URL('../dist/src/db/schema.sql', import.meta.url));
mkdirSync(new URL('../dist/contracts/', import.meta.url), { recursive: true });
cpSync(new URL('../contracts/openapi.json', import.meta.url), new URL('../dist/contracts/openapi.json', import.meta.url));
mkdirSync(new URL('../dist/file-engine/', import.meta.url), { recursive: true });
cpSync(new URL('../file-engine/worker.py', import.meta.url), new URL('../dist/file-engine/worker.py', import.meta.url));
cpSync(new URL('../file-engine/templates/', import.meta.url), new URL('../dist/file-engine/templates/', import.meta.url), { recursive: true });
