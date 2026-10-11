import test from 'node:test';
import assert from 'node:assert/strict';
import * as calendarUi from './calendar-ui.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('preview sends only the trigger and displays the server-calculated next execution',async()=>{
 assert.equal(typeof calendarUi.beginSchedulePreview,'function');
 const states=[];
 const cancel=calendarUi.beginSchedulePreview({kind:'daily',time:'09:00',timezone:'Europe/Berlin'},async(path,method,body,key,signal)=>{
  assert.equal(path,'/persistent-tasks/preview');
  assert.equal(method,'POST');
  assert.deepEqual(body,{trigger:{kind:'daily',time:'09:00',timezone:'Europe/Berlin'}});
  assert.equal(key,undefined);
  assert.equal(signal.aborted,false);
  return {next_due_at:'2026-10-03T07:00:00.000Z',timezone:'Europe/Berlin'};
 },state=>states.push(state),5);
 await pause(20);
 cancel();
 assert.deepEqual(states,[{status:'loading'},{status:'ready',result:{next_due_at:'2026-10-03T07:00:00.000Z',timezone:'Europe/Berlin'}}]);
});
test('changing or closing a form before debounce cancels the pending preview',async()=>{
 assert.equal(typeof calendarUi.beginSchedulePreview,'function');
 const states=[];
 let requested=false;
 const cancel=calendarUi.beginSchedulePreview({kind:'once'},async()=>{requested=true;throw new Error('Cancelled preview must not reach the server');},state=>states.push(state),5);
 cancel();
 await pause(20);
 assert.equal(requested,false);
 assert.deepEqual(states,[{status:'loading'}]);
});
test('cancelled previews abort the request and cannot publish a late server result',async()=>{
 assert.equal(typeof calendarUi.beginSchedulePreview,'function');
 const states=[];
 let signal,finish;
 const cancel=calendarUi.beginSchedulePreview({kind:'once'},async(path,method,body,key,requestSignal)=>{
  assert.deepEqual(body,{trigger:{kind:'once'}});
  signal=requestSignal;
  return await new Promise(resolve=>{finish=resolve;});
 },state=>states.push(state),5);
 await pause(20);
 cancel();
 assert.equal(signal.aborted,true);
 finish({next_due_at:'2026-10-02T12:00:00.000Z',timezone:null});
 await pause(0);
 assert.deepEqual(states,[{status:'loading'}]);
});
test('server preview failure is visible without claiming an execution time',async()=>{
 assert.equal(typeof calendarUi.beginSchedulePreview,'function');
 const states=[];
 const cancel=calendarUi.beginSchedulePreview({kind:'weekly',time:'09:00',timezone:'UTC',weekdays:[1]},async()=>{throw new Error('Service unavailable');},state=>states.push(state),5);
 await pause(20);
 cancel();
 assert.deepEqual(states,[{status:'loading'},{status:'error',message:'Service unavailable'}]);
});
