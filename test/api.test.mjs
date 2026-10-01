import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

test('API rejects cross-origin writes, persists one run and exposes no credentials',async()=>{
  const {buildServer}=await import('../src/server.mjs');
  const service=await buildServer({database:':memory:',root:process.env.JOT_TEST_TMP??'.data/test',demo:true});
  try {
    const boot=await service.app.inject({url:'/api/capabilities'});const {csrf}=boot.json();
    assert.equal(boot.json().mode,'demo');assert.ok(csrf);assert.equal(boot.json().api_key,undefined);
    const blocked=await service.app.inject({method:'POST',url:'/api/conversations',headers:{origin:'https://evil.example','x-jot-token':csrf},payload:{title:'Bad'}});assert.equal(blocked.statusCode,403);
    const create=await service.app.inject({method:'POST',url:'/api/conversations',headers:{'x-jot-token':csrf},payload:{title:'Test'}});assert.equal(create.statusCode,200);const id=create.json().id;
    const send=await service.app.inject({method:'POST',url:`/api/conversations/${id}/messages`,headers:{'x-jot-token':csrf},payload:{text:'hello',request_id:'req-1'}});assert.equal(send.statusCode,202);
    await service.agent.close();
    const duplicate=await service.app.inject({method:'POST',url:`/api/conversations/${id}/messages`,headers:{'x-jot-token':csrf},payload:{text:'hello',request_id:'req-1'}});assert.equal(duplicate.json().run.id,send.json().run.id);
    const snapshot=await service.app.inject({url:`/api/conversations/${id}/snapshot`,headers:{'x-jot-token':csrf}});assert.equal(snapshot.json().messages.filter(m=>m.role==='user').length,1);
    assert.equal((await service.app.inject({url:'/api/conversations'})).statusCode,403);
  }finally{await service.close();}
});

test('uploaded files download exactly and expired artifacts return 410',async()=>{
  const {buildServer}=await import('../src/server.mjs');
  const cache=process.env.JOT_TEST_TMP??fileURLToPath(new URL('../../../.cache/jot-tests/',import.meta.url));await mkdir(cache,{recursive:true});const root=await mkdtemp(join(cache,'api-files-'));
  const service=await buildServer({database:':memory:',root,demo:true});
  try {
    const headers={'x-jot-token':(await service.app.inject({url:'/api/capabilities'})).json().csrf};
    const id=(await service.app.inject({method:'POST',url:'/api/conversations',headers,payload:{}})).json().id;
    const file=await service.app.inject({method:'POST',url:`/api/conversations/${id}/files`,headers,payload:{name:'说明.md',text:'你好'}});assert.equal(file.statusCode,200);
    const download=await service.app.inject({url:`/api/artifacts/${file.json().id}/download`,headers});assert.equal(download.statusCode,200);assert.equal(download.body,'你好');assert.match(download.headers['content-disposition'],/filename\*=UTF-8''/);
    await unlink(service.store.getArtifact(file.json().id).path);
    assert.equal((await service.app.inject({url:`/api/artifacts/${file.json().id}/download`,headers})).statusCode,410);
  }finally{await service.close();await rm(root,{recursive:true,force:true});}
});

test('shutdown terminates an open SSE stream instead of waiting forever for a viewer',async()=>{
  const {buildServer}=await import('../src/server.mjs');
  const service=await buildServer({database:':memory:',demo:true}),controller=new AbortController();let closing;
  try {
    const base=await service.app.listen({host:'127.0.0.1',port:0});
    const csrf=(await (await fetch(base+'/api/capabilities')).json()).csrf;
    const c=service.store.createConversation();service.store.event(c.id,'ready',{ready:true});
    const response=await fetch(base+`/api/conversations/${c.id}/events`,{headers:{'x-jot-token':csrf},signal:controller.signal});assert.equal(response.status,200);
    closing=service.close();let timer;
    try{await Promise.race([closing,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('SSE prevented shutdown')),1000))]);}finally{clearTimeout(timer);}
  }finally{controller.abort();await (closing??service.close());}
});
