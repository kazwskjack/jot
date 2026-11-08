import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const output=new URL('../../.test-tmp/interaction-card-browser/',import.meta.url);await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./InteractionCard.tsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:new URL('card.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {default:InteractionCard}=await import(new URL('card.mjs',output));
test('browser approvals reuse the existing interaction card with an operation summary, risk and standard decision wording',()=>{
 const value={interaction_id:'int-browser-1',run_id:'run-1',tool_call_id:'browser-call-1',version:1,status:'pending',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+60_000).toISOString(),
  kind:'approval',purpose:'browser_action',action_digest:'sha256:'+'a'.repeat(64),action_summary:'Browser click: https://fixture.example/ · button Increment',risk:'medium'};
 const html=renderToStaticMarkup(React.createElement(InteractionCard,{value,disabled:false,submit:async()=>({accepted:true,interaction_id:value.interaction_id}),onRefresh:async()=>{}}));
 assert.match(html,/确认浏览器操作/);assert.match(html,/Browser click: https:\/\/fixture\.example\//);assert.match(html,/风险：medium/);
 assert.match(html,/批准此浏览器操作/);assert.match(html,/拒绝此浏览器操作/);assert.doesNotMatch(html,/继续核验|确认并继续/);
});
