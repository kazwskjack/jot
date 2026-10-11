import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {scanPublicTree} from './verify-public.mjs';

async function scan(t,source,file='source.mjs'){
 const base=resolve('.test-tmp/public-review');mkdirSync(base,{recursive:true});
 const root=mkdtempSync(join(base,'case-'));
 t.after(()=>{const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true});});
 const path=join(root,file);mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,source);
 return (await scanPublicTree(root)).findings.map(x=>x.rule);
}

test('public retry keys and explicit test tokens do not masquerade as credentials',async t=>{
 assert.deepEqual(await scan(t,`const headers={'idempotency-key':'retry-identifier-long-value','token':'test-auth-12345678'};`),[]);
});
test('authentication literals still fail even beside an idempotency key',async t=>{
 const source=`const headers={'idempotency-key':'retry-identifier-long-value','token':'${'q'.repeat(32)}'};`;
 assert.deepEqual(await scan(t,source),['literal_secret']);
});
test('only the exact documented adversarial URL fixture is accepted inside tests',async t=>{
 const url=new URL('https://example.test/private');url.username='test-user';url.password='test-password';
 assert.deepEqual(await scan(t,JSON.stringify(url.href),'packages/gateway/test/rejection.test.mjs'),[]);
 assert.deepEqual(await scan(t,JSON.stringify(url.href)),['url_credentials']);
 url.password='unmarked';assert.deepEqual(await scan(t,JSON.stringify(url.href),'packages/gateway/test/rejection.test.mjs'),['url_credentials']);
 url.password='test-password';url.hostname='outside.example';assert.deepEqual(await scan(t,JSON.stringify(url.href),'packages/gateway/test/rejection.test.mjs'),['url_credentials']);
});
