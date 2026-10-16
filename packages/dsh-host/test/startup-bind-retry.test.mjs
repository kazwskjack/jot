import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
const start=(await import('./startup-bind-retry.mjs').catch(()=>({}))).startFixtureWithBindRetry;
const failure={exited:true,exitCode:1,exitSignal:null,ready:false,inputSubmitted:false,port:32123,output:'Error: listen EADDRINUSE: address already in use 127.0.0.1:32123\n'};

test('an exited pre-ready bind collision can rebind once and start a real isolated listener',async()=>{
 assert.equal(typeof start,'function');const blocker=createServer();await new Promise(r=>blocker.listen(0,'127.0.0.1',r));let port=blocker.address().port,child,exitPromise,state,calls=0,rebinds=0;
 try{await start({start:async()=>{calls++;state={...failure,port,exited:false,exitCode:null,output:''};
   child=spawn(process.execPath,['-e',"const s=require('node:net').createServer();s.listen(Number(process.argv[1]),'127.0.0.1',()=>console.log('READY'));",String(port)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
   exitPromise=new Promise(r=>child.once('exit',(code,signal)=>{state.exited=true;state.exitCode=code;state.exitSignal=signal;r();}));
   await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>reject(Error('fixture_start_failed')));child.stderr.on('data',b=>state.output+=b);child.stdout.on('data',b=>{if(String(b).includes('READY')){state.ready=true;resolve();}});});
  },inspectFailure:async()=>({...state}),rebind:async()=>{rebinds++;port=0;}});
  assert.equal(calls,2);assert.equal(rebinds,1);assert.equal(state.ready,true);
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await exitPromise;}await new Promise(r=>blocker.close(r));}
});

test('observation timeouts, unknown exits, permission failures, ready or submitted work never restart',async()=>{
 assert.equal(typeof start,'function');
 for(const patch of [{exited:false},{exitCode:null},{exitCode:0},{exitSignal:'SIGTERM'},{ready:true},{inputSubmitted:true},{output:'Error: listen EACCES: permission denied 127.0.0.1:32123'},{port:32124}]){
  let calls=0,rebinds=0;const error=Error('original_failure');await assert.rejects(start({start:async()=>{calls++;throw error;},inspectFailure:async()=>({...failure,...patch}),rebind:async()=>{rebinds++;}}),e=>e===error);assert.equal(calls,1);assert.equal(rebinds,0);
 }
});

test('collisions stay bounded and cancellation cannot create another Host',async()=>{
 assert.equal(typeof start,'function');let calls=0,rebinds=0;const error=Error('bind_failure');await assert.rejects(start({start:async()=>{calls++;throw error;},inspectFailure:async()=>failure,rebind:async()=>{rebinds++;}}),e=>e===error);assert.equal(calls,3);assert.equal(rebinds,2);
 const cancel=new AbortController();calls=0;rebinds=0;await assert.rejects(start({start:async()=>{calls++;cancel.abort();throw error;},inspectFailure:async()=>failure,rebind:async()=>{rebinds++;},signal:cancel.signal}));assert.equal(calls,1);assert.equal(rebinds,0);
});
