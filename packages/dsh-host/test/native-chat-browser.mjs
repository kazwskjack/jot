// Actual UI + original standalone BFF, with a fixed fixture owner. No API shim.
import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';import {chromium} from 'playwright';import {buildServer} from '../../../src/server.mjs';
export async function nativeChatBrowser({root,gateway,csrf,origins,owner="chat-owner",conversationId=""}){
 const publicRoot=join(root,'browser-ui');await mkdir(publicRoot);
 const source="import '../workbench-entry.css';import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import ConversationPicker from './ConversationPicker';import RoleConversation from './RoleConversation';function App(){const[id,setId]=useState("+JSON.stringify(conversationId)+");return id?React.createElement(RoleConversation,{ordinary:true,id,onClose:()=>setId('')}):React.createElement(ConversationPicker,{onOpen:setId});}createRoot(document.getElementById('root')).render(React.createElement(App));";
 await build({stdin:{contents:source,loader:'tsx',resolveDir:fileURLToPath(new URL('../../../web/jot/',import.meta.url))},bundle:true,outfile:join(publicRoot,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
 await writeFile(join(publicRoot,'index.html'),'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>');
 let bff,browser;
 try{
  bff=await buildServer({demo:true,database:join(root,'bff.sqlite'),root:join(root,'bff-files'),publicRoot,workbench:{url:gateway,owner,csrf}});
  await bff.app.listen({host:'127.0.0.1',port:0});const origin='http://127.0.0.1:'+bff.app.server.address().port;origins.push(origin);
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{}),env:{...process.env}});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());const page=await context.newPage(),faults=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>faults.push(e.message));await page.goto(origin);
  return{page,faults,close:async()=>{await browser.close();bff.app.server.closeAllConnections();await bff.close();}};
 }catch(error){await browser?.close();await bff?.close();throw error;}
}
