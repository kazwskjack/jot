import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';
import {createTools} from '../src/tools.mjs';

const temp=process.env.JOT_TEST_TMP??tmpdir();
const url='https://example.com/fixture';
const html='<!doctype html><html><head><title>Browser fixture</title></head><body><main><label>Search <input aria-label="Search" type="text"></label><div contenteditable="true" aria-label="Notes">Draft</div><p id="result">Ready</p><div style="height:1400px"></div><button aria-label="Continue" onclick="document.querySelector(\'#result\').textContent=\'Clicked \'+document.querySelector(\'input\').value">Continue</button></main></body></html>';

test('real Chromium reads, fills, scrolls and clicks an allowlisted fixture with durable receipts',async t=>{
  await mkdir(temp,{recursive:true});
  const root=await mkdtemp(join(temp,'browser-actions-chromium-'));
  const store=new Store(join(root,'fixture.db'));
  const run=store.accept(store.createConversation().id,'Exercise browser controls','browser-fixture').run;
  let realBrowser,tools;
  t.after(async()=>{if(tools)await tools.close();else await realBrowser?.close();store.close();await rm(root,{recursive:true,force:true});});
  realBrowser=await chromium.launch({headless:true,...(process.env.JOT_TEST_CHROME_PATH?{executablePath:process.env.JOT_TEST_CHROME_PATH}:{})});
  const requests=[];
  const browserFactory=async()=>({
    newContext:async options=>{
      const browserContext=await realBrowser.newContext(options);
      await browserContext.route('**/*',async route=>{
        const requested=route.request().url();requests.push(requested);
        if(requested===url)await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
        else await route.abort();
      });
      return browserContext;
    },
    close:()=>realBrowser.close(),
  });
  tools=createTools({store,root:join(root,'files'),origins:new Set(['https://example.com']),browserEnabled:true,browserFactory});
  const approvals=[];
  const context=callId=>({run,callId,signal:new AbortController().signal,approve:async(description,operation)=>approvals.push({callId,description,operation})});

  const initial=await tools.execute('browser_action',{url,action:'read'},context('chromium-read'));
  assert.equal(initial.url,url);
  assert.equal(initial.title,'Browser fixture');
  assert.ok(initial.text.includes('Ready'));
  const textbox=initial.candidates.find(candidate=>candidate.role==='textbox');
  const button=initial.candidates.find(candidate=>candidate.name==='Continue');
  const editor=initial.candidates.find(candidate=>candidate.name==='Notes'&&candidate.role==='textbox');
  assert.ok(textbox);assert.ok(editor);assert.ok(button);

  const filled=await tools.execute('browser_action',{url,action:'fill',candidate_id:textbox.candidate_id,page_revision:initial.page_revision,text:'hello'},context('chromium-fill'));
  assert.equal(filled.browser_receipt.status,'succeeded');
  assert.equal(approvals.at(-1).operation.target.name,'Search');
  assert.equal(approvals.at(-1).operation.text,'hello');

  const edited=await tools.execute('browser_action',{url,action:'fill',candidate_id:editor.candidate_id,page_revision:filled.page_revision,text:'drafted'},context('chromium-contenteditable'));
  assert.equal(edited.browser_receipt.status,'succeeded');
  const editedButton=edited.candidates.find(candidate=>candidate.name==='Continue');
  assert.ok(editedButton);

  const scrolled=await tools.execute('browser_action',{url,action:'scroll',candidate_id:editedButton.candidate_id,page_revision:edited.page_revision},context('chromium-scroll'));
  assert.equal(scrolled.browser_receipt.status,'succeeded');
  assert.match(scrolled.page_revision,/^[a-f0-9]{64}$/);
  const currentButton=scrolled.candidates.find(candidate=>candidate.name==='Continue');
  assert.ok(currentButton);

  const clicked=await tools.execute('browser_action',{url,action:'click',candidate_id:currentButton.candidate_id,page_revision:scrolled.page_revision},context('chromium-click'));
  assert.equal(clicked.browser_receipt.status,'succeeded');
  assert.match(clicked.text,/Clicked hello/);
  assert.notEqual(clicked.page_revision,scrolled.page_revision);
  for(const callId of ['chromium-read','chromium-fill','chromium-contenteditable','chromium-scroll','chromium-click']){
    const receiptEvents=store.events(run.conversation_id,0).filter(event=>event.data.call_id===callId&&event.type.startsWith('browser.operation.'));
    assert.deepEqual(receiptEvents.map(event=>event.type),['browser.operation.accepted','browser.operation.succeeded']);
  }
  assert.ok(requests.length>0);assert.ok(requests.every(requested=>new URL(requested).origin==='https://example.com'));
  assert.equal(store.events(run.conversation_id,0).some(event=>JSON.stringify(event.data).includes('data:text/html')),false);
});
