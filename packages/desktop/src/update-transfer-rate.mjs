// Measured committed-byte throughput; existing/rescanned bytes are not samples.
import {performance} from 'node:perf_hooks';
export function createUpdateTransferRate(){
 let sample=null,latest=null,rate=null,rateTime=null;
 function reset(){sample=null;latest=null;rate=null;rateTime=null;}
 function observe(received){
  const time=performance.now();
  if(!Number.isSafeInteger(received)||received<=0){reset();return;}
  if(!latest||received<latest.received||time<latest.time||time-latest.time>2000){
   sample={received,time};latest=sample;rate=null;rateTime=null;return;
  }
  if(received===latest.received)return;
  latest={received,time};
  const elapsed=time-sample.time;
  if(elapsed<250)return;
  const measured=(received-sample.received)/elapsed*1000;
  rate=Number.isFinite(measured)&&measured>=0&&measured<=Number.MAX_SAFE_INTEGER?measured:null;
  rateTime=time;sample=latest;
 }
 function read(){
  const time=performance.now();
  return latest&&rateTime!==null&&time>=rateTime&&time-rateTime<=2000&&time-latest.time<=2000?rate:null;
 }
 return Object.freeze({observe,read,reset});
}
