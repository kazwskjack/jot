import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadWorker(){
 const source=await readFile(new URL('../public/workbench-notifications-sw.js',import.meta.url),'utf8'),listeners=new Map();
 const self={location:{origin:'https://jot.example.test'},registration:{showNotification:async(...args)=>args},clients:{matchAll:async()=>[],openWindow:async url=>({opened:url})},addEventListener:(type,listener)=>listeners.set(type,listener)};
 vm.runInNewContext(source,{self,URL});
 return {self,listeners};
}

test('push service worker displays a generic notification and ignores provider payload contents',async()=>{
 const {self,listeners}=await loadWorker(),data={title:'SECRET task title',body:'private task output',url:'https://attacker.example.test/'};let shown;
 await listeners.get('push')({data:{json:()=>data},waitUntil:promise=>{shown=promise;}});
 assert.deepEqual(JSON.parse(JSON.stringify(await shown)),['Jot 任务更新',{body:'你有一条任务更新，请打开 Jot 查看。',data:{url:'/workbench.html'}}]);
});

test('notification click focuses an existing same-origin Workbench or opens the fixed local route',async()=>{
 const {self,listeners}=await loadWorker();let focused=0,opened='';
 self.clients.matchAll=async()=>[{url:'https://jot.example.test/workbench.html',focus:async()=>{focused++;return 'focused';}}];
 const event={notification:{close(){}},waitUntil:promise=>{event.result=promise;}};
 listeners.get('notificationclick')(event);assert.equal(await event.result,'focused');assert.equal(focused,1);assert.equal(opened,'');
 self.clients.matchAll=async()=>[];self.clients.openWindow=async url=>{opened=url;return 'opened';};
 const second={notification:{close(){}},waitUntil:promise=>{second.result=promise;}};
 listeners.get('notificationclick')(second);assert.equal(await second.result,'opened');assert.equal(opened,'https://jot.example.test/workbench.html');
 self.clients.matchAll=async()=>[{url:'https://attacker.example.test/workbench.html',focus:async()=>{focused++;return 'foreign-focus';}}];opened='';
 const third={notification:{close(){}},waitUntil:promise=>{third.result=promise;}};
 listeners.get('notificationclick')(third);assert.equal(await third.result,'opened');assert.equal(focused,1);assert.equal(opened,'https://jot.example.test/workbench.html');
});
