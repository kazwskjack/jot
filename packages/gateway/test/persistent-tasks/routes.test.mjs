import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

test('task route accepts explicit unlimited JSON null but not zero or forged budget mode',async()=>{
 const {registerPersistentTaskRoutes}=await import('../../src/persistent-tasks/routes.ts'),app=Fastify(),seen=[];
 registerPersistentTaskRoutes(app,{create(owner,body){seen.push({owner,body});return{task_id:'task-a',budget:body.budget};}},()=> 'alice');
 try{const payload={title:'x',agent_id:'agent',objective:'x',trigger:{kind:'once'},budget:{max_runs:null}};
  const good=await app.inject({method:'POST',url:'/v1/persistent-tasks',payload});assert.equal(good.statusCode,201);assert.equal(good.json().budget.max_runs,null);assert.equal(seen[0].owner,'alice');
  for(const budget of [{max_runs:0},{max_runs:-1},{max_runs:'unlimited'},{max_runs:null,run_limit_mode:'unlimited'}]){const bad=await app.inject({method:'POST',url:'/v1/persistent-tasks',payload:{...payload,budget}});assert.equal(bad.statusCode,400);}
  assert.equal(seen.length,1);
 }finally{await app.close();}
});

test('persistent routes export registration function',async()=>{
  const m=await import('../../src/persistent-tasks/routes.ts').catch(()=>({}));assert.equal(typeof m.registerPersistentTaskRoutes,'function');
});
test('routes require owner from actor, validate CAS and request run idempotency',async()=>{
  const {registerPersistentTaskRoutes}=await import('../../src/persistent-tasks/routes.ts');
  const app=Fastify();const calls=[];
  app.setErrorHandler((e,_req,reply)=>reply.code(e.message==='version_conflict'?409:400).send({error:{code:e.message}}));
  const service={create(owner,body,key){calls.push({owner,body,key});return{task_id:'task-a'};},pause(owner,id,version){calls.push({owner,id,version});return{status:'paused'};},runNow(owner,id,key){calls.push({owner,id,key});return{run_id:'run-a'};}};
  registerPersistentTaskRoutes(app,service,req=>String(req.headers['x-user-id']??''));
  try{
    const created=await app.inject({method:'POST',url:'/v1/persistent-tasks',headers:{'x-user-id':'alice'},payload:{title:'Check',agent_id:'agent-a',objective:'Check',trigger:{kind:'once'}}});assert.equal(created.statusCode,201);assert.equal(calls[0].owner,'alice');
    const invalid=await app.inject({method:'POST',url:'/v1/persistent-tasks/task-a/pause',headers:{'x-user-id':'alice'},payload:{expected_version:'1'}});assert.equal(invalid.statusCode,400);
    const paused=await app.inject({method:'POST',url:'/v1/persistent-tasks/task-a/pause',headers:{'x-user-id':'alice'},payload:{expected_version:1}});assert.equal(paused.statusCode,200);assert.equal(calls.at(-1).version,1);
    const missing=await app.inject({method:'POST',url:'/v1/persistent-tasks/task-a/run-now',headers:{'x-user-id':'alice'},payload:{}});assert.equal(missing.statusCode,400);
    const run=await app.inject({method:'POST',url:'/v1/persistent-tasks/task-a/run-now',headers:{'x-user-id':'alice','idempotency-key':'stable'},payload:{}});assert.equal(run.statusCode,202);assert.equal(calls.at(-1).key,'stable');
    const forged=await app.inject({method:'POST',url:'/v1/persistent-tasks',headers:{'x-user-id':'alice'},payload:{title:'Check',agent_id:'agent-a',objective:'Check',trigger:{kind:'once'},owner_id:'bob'}});assert.equal(forged.statusCode,400);
  }finally{await app.close();}
});
