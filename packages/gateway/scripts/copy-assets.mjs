import { cpSync, mkdirSync } from 'node:fs';

mkdirSync(new URL('../dist/src/network/', import.meta.url), { recursive: true });
cpSync(new URL('../src/network/public-address.js', import.meta.url), new URL('../dist/src/network/public-address.js', import.meta.url));

mkdirSync(new URL('../dist/src/harness/', import.meta.url), { recursive: true });
cpSync(new URL('../../session-adapter/native-tool-result.js', import.meta.url), new URL('../dist/src/harness/native-tool-result.js', import.meta.url));

mkdirSync(new URL('../dist/src/db/', import.meta.url), { recursive: true });
cpSync(new URL('../src/db/schema.sql', import.meta.url), new URL('../dist/src/db/schema.sql', import.meta.url));
mkdirSync(new URL('../dist/contracts/', import.meta.url), { recursive: true });
cpSync(new URL('../contracts/openapi.json', import.meta.url), new URL('../dist/contracts/openapi.json', import.meta.url));
mkdirSync(new URL('../dist/file-engine/', import.meta.url), { recursive: true });
cpSync(new URL('../file-engine/worker.py', import.meta.url), new URL('../dist/file-engine/worker.py', import.meta.url));
cpSync(new URL('../file-engine/templates/', import.meta.url), new URL('../dist/file-engine/templates/', import.meta.url), { recursive: true });

mkdirSync(new URL('../dist/src/artifacts/', import.meta.url), { recursive: true });
cpSync(new URL('../src/artifacts/office-preview-format.js', import.meta.url), new URL('../dist/src/artifacts/office-preview-format.js', import.meta.url));
cpSync(new URL('../src/artifacts/office-preview-format.d.ts', import.meta.url), new URL('../dist/src/artifacts/office-preview-format.d.ts', import.meta.url));
cpSync(new URL('../src/artifacts/archive-windows-job.ps1', import.meta.url), new URL('../dist/src/artifacts/archive-windows-job.ps1', import.meta.url));

mkdirSync(new URL('../dist/src/messages/', import.meta.url), { recursive: true });
cpSync(new URL('../src/messages/content-reference.js', import.meta.url), new URL('../dist/src/messages/content-reference.js', import.meta.url));
