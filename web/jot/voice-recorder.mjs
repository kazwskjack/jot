// PCM is kept in this page only and encoded into the existing voice adapter's WAV contract.
export function encodeVoiceWave(samples,sampleRate,maxBytes=2*1024*1024){
 if(!samples.length||!Number.isFinite(sampleRate)||sampleRate<16000)throw Error('VOICE_AUDIO_EMPTY');
 const count=Math.floor(samples.length*16000/sampleRate);if(!count)throw Error('VOICE_AUDIO_EMPTY');
 if(count*2+44>maxBytes)throw Error('VOICE_AUDIO_TOO_LARGE');
 const bytes=new Uint8Array(44+count*2),view=new DataView(bytes.buffer);
 const tag=(offset,value)=>{for(let i=0;i<value.length;i++)bytes[offset+i]=value.charCodeAt(i);};
 tag(0,'RIFF');view.setUint32(4,bytes.length-8,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);
 view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);
 view.setUint16(32,2,true);view.setUint16(34,16,true);tag(36,'data');view.setUint32(40,count*2,true);
 for(let i=0;i<count;i++){
  const begin=Math.floor(i*sampleRate/16000),end=Math.min(samples.length,Math.floor((i+1)*sampleRate/16000));let sum=0;
  for(let j=begin;j<end;j++)sum+=Number.isFinite(samples[j])?samples[j]:0;
  const sample=Math.max(-1,Math.min(1,sum/(end-begin)));view.setInt16(44+i*2,Math.round(sample*(sample<0?32768:32767)),true);
 }
 return bytes;
}

export async function recordVoice({signal=new AbortController().signal,maxDurationMs=60000,maxBytes=2*1024*1024,onLimit=()=>{},onLevel=()=>{},env=globalThis}={}){
 const Audio=env.AudioContext??env.webkitAudioContext;
 if(env.isSecureContext===false||!Audio||!env.navigator?.mediaDevices?.getUserMedia)throw Error('VOICE_RECORDING_UNSUPPORTED：此浏览器无法录音，请使用支持麦克风的 HTTPS 浏览器');
 if(signal.aborted)throw new DOMException('Aborted','AbortError');
 const context=new Audio();let stream,source,processor,gain,timer,startupTimer,closed=false,chunks=[],length=0;
 const stopStream=value=>{for(const track of value.getTracks()){track.onended=null;track.stop();}};
 const cleanup=()=>{
  if(closed)return;closed=true;clearTimeout(timer);clearTimeout(startupTimer);signal.removeEventListener('abort',abort);
  if(processor)processor.onaudioprocess=null;
  for(const node of [source,processor,gain]){try{node?.disconnect();}catch{}}
  if(stream)stopStream(stream);void context.close().catch(()=>{});
 };
 let rejectAbort;const cancelled=new Promise((_,reject)=>{rejectAbort=reject;});
 const abort=()=>{cleanup();chunks=[];rejectAbort(new DOMException('Aborted','AbortError'));};
 signal.addEventListener('abort',abort,{once:true});
 startupTimer=setTimeout(()=>{cleanup();chunks=[];rejectAbort(Error('VOICE_MICROPHONE_TIMEOUT：麦克风启动超时，请检查浏览器权限后重试'));},20000);
 try{
  // Start AudioContext from the user's click, before awaiting the permission prompt.
  const resumed=context.resume();
  const permission=env.navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false}).then(value=>{if(closed){stopStream(value);throw new DOMException('Aborted','AbortError');}stream=value;return value;});
  await Promise.race([Promise.all([resumed,permission]),cancelled]);
  clearTimeout(startupTimer);
  if(closed)throw new DOMException('Aborted','AbortError');
  source=context.createMediaStreamSource(stream);processor=context.createScriptProcessor(4096,1,1);gain=context.createGain();gain.gain.value=0;
  const seconds=Math.min(60,Math.max(0,(maxDurationMs??60000)/1000),Math.max(0,((maxBytes??2097152)-44)/32000));
  if(seconds<=0)throw Error('VOICE_AUDIO_LIMIT_INVALID');
  const limit=Math.floor(seconds*context.sampleRate);let limitNotified=false;
  const reached=()=>{if(!closed&&!limitNotified){limitNotified=true;onLimit();}};
  processor.onaudioprocess=event=>{
   if(closed)return;const input=event.inputBuffer.getChannelData(0),take=Math.min(input.length,limit-length);
   if(take>0){
    const chunk=new Float32Array(input.slice(0,take));chunks.push(chunk);length+=take;
    let energy=0;for(const sample of chunk)energy+=Number.isFinite(sample)?sample*sample:0;
    onLevel({level:Math.min(1,Math.sqrt(energy/take)),elapsedMs:Math.round(length/context.sampleRate*1000)});
   }
   if(length>=limit)reached();
  };
  source.connect(processor);processor.connect(gain);gain.connect(context.destination);
  for(const track of stream.getTracks())track.onended=reached;
  timer=setTimeout(reached,seconds*1000);
  return {
   finish(){if(closed)throw Error('VOICE_RECORDING_CLOSED');cleanup();const samples=new Float32Array(length);let offset=0;for(const chunk of chunks){samples.set(chunk,offset);offset+=chunk.length;}chunks=[];return encodeVoiceWave(samples,context.sampleRate,maxBytes);},
   cancel(){cleanup();chunks=[];},
  };
 }catch(error){cleanup();chunks=[];if(error?.name==='AbortError')throw error;if(error?.name==='NotAllowedError')throw Error('麦克风权限被拒绝 (NotAllowedError)：请在浏览器权限中允许麦克风后重试');throw error;}
}
