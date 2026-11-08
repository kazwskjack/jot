import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {browserTestLaunchOptions} from '../../scripts/browser-test-launch.mjs';

test('actual Goal page exposes a keyboard-operable stop alert dialog and preserves controller requests', {timeout:90000}, async()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const scratch=resolve(root,'.test-tmp/conversation-goal-a11y');
 await mkdir(scratch,{recursive:true});
 const previous={TEMP:process.env.TEMP,TMP:process.env.TMP};process.env.TEMP=scratch;process.env.TMP=scratch;
 const [baseCss,css]=await Promise.all([readFile(resolve(root,'web/style.css'),'utf8'),readFile(resolve(root,'web/jot/prompt-composer.css'),'utf8')]);
 const bundle=await build({stdin:{contents:`import React,{useRef,useState} from 'react';import{createRoot}from'react-dom/client';import ConversationGoal from './web/jot/ConversationGoal.tsx';function Harness(){const[pending,setPending]=useState(false),region=useRef(null);return <main><section ref={region} role="region" aria-label="Ordinary conversation" tabIndex={-1}><button>Focus anchor</button><ConversationGoal id="goal-fixture" running={false} onStopCompleted={()=>region.current?.focus()} onPendingChange={setPending}/></section><output id="pending">{String(pending)}</output></main>};createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic'});
 const csrf='goal-a11y-csrf',scope='d'.repeat(64),calls=[],faults=[],requests=[];
 const origin='https://jot.test',html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${baseCss}${css}</style><div id="root"></div><script type="module" src="/bundle.js"></script>`;
 let browser,context,page;
 try{
  const options={...await browserTestLaunchOptions(chromium),headless:true,env:{...process.env,TEMP:scratch,TMP:scratch}};
  browser=await chromium.launch(options);context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();requests.push({path:url.pathname,method:request.method()});
   if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:html});
   if(url.pathname==='/bundle.js')return route.fulfill({status:200,contentType:'application/javascript',body:bundle.outputFiles[0].text});
   const path=url.pathname.replace('/workbench-api/v1','');
   const headers={'x-csrf-token':csrf,'x-workbench-draft-scope':scope};
   const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',headers,body:JSON.stringify(value)});
   if(path==='/capabilities'&&request.method()==='GET')return json({workspaces:[],limits:{max_upload_bytes:1000000},workbench:{enabled:true}});
   if(path==='/conversations/goal-fixture/goal'&&request.method()==='GET')return json({goal:{id:'goal-fixture',revision:4,objective:'Review the current task',phase:'active',activation:'armed',roundsStarted:1,maxGoalRounds:10}});
   if(path==='/conversations/goal-fixture/goal'&&request.method()==='POST'){calls.push({body:JSON.parse(request.postData()??'{}'),key:request.headers()['idempotency-key'],csrf:request.headers()['x-csrf-token']});return json({goal:null});}
   if(url.pathname==='/favicon.ico')return route.fulfill({status:204,body:''});
   return route.fulfill({status:404,body:'Not found'});
  });
  page=await context.newPage();page.on('pageerror',error=>faults.push(error.message));await page.goto(origin);
  await page.getByRole('region',{name:'当前目标'}).waitFor();const stop=page.getByRole('button',{name:'停止',exact:true});await stop.waitFor();
  await stop.tap();
  const dialog=page.getByRole('alertdialog',{name:'停止当前目标'});await dialog.waitFor();
  assert.match(await dialog.ariaSnapshot(),/alertdialog \"停止当前目标\"/,'browser accessibility tree exposes a named alert dialog');
  assert.equal(await dialog.getAttribute('aria-modal'),'true','stop confirmation must expose a modal dialog to assistive technology');
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent?.trim()),'返回','opening the stop dialog places focus on its safe cancel action');
  const readDialogColors=()=>page.evaluate(()=>{const dialog=document.querySelector('.jot-goal-stop-dialog'),probe=document.createElement('span');probe.style.color='var(--ink)';document.body.append(probe);const ink=getComputedStyle(probe).color;probe.remove();return {dialog:getComputedStyle(dialog).color,button:getComputedStyle(dialog.querySelector('button')).color,ink};});
  let colors=await readDialogColors();assert.equal(colors.dialog,colors.ink,'dark theme dialog text uses the host ink token');assert.equal(colors.button,colors.ink,'dark theme dialog button text remains readable');
  await page.evaluate(()=>document.documentElement.dataset.theme='light');colors=await readDialogColors();assert.equal(colors.dialog,colors.ink,'light theme dialog text uses the host ink token');assert.equal(colors.button,colors.ink,'light theme dialog button text remains readable');await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent?.trim()),'停止','Escape cancels and returns focus to the opener');assert.equal(calls.length,0,'Escape must not send a Goal control request');
  await stop.tap();await dialog.waitFor();await page.getByRole('button',{name:'确认停止目标'}).tap();await page.waitForTimeout(200);
  assert.equal(calls.length,1,`stop request should be sent exactly once; requests=${JSON.stringify(requests)}; page state: ${await page.locator('body').innerText()}`);assert.ok(calls[0].key);assert.equal(calls[0].csrf,csrf);assert.deepEqual(calls[0].body,{action:'stop',id:'goal-fixture',revision:4});await dialog.waitFor({state:'hidden'});assert.equal(await page.getByRole('region',{name:'当前目标'}).count(),0,`successful stop clears the active goal; page state: ${await page.locator('body').innerText()}`);assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Ordinary conversation','after successful stop, focus moves to the stable conversation region');assert.deepEqual(faults,[]);
 }finally{
  try{await context?.close();await browser?.close();}finally{await rm(scratch,{recursive:true,force:true});for(const key of ['TEMP','TMP'])if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
 }
});
