import {validateTerminalAttachment,validateTerminalInputPacket,validateTerminalAttached,validateTerminalQueued,projectTerminalFrame} from '../gateway/src/terminal/stream.js';

function inputQueue(maxBytes) {
  const entries=new Map();let bytes=0,sequence=0,waiting,closed=false;
  const end=()=>{closed=true;entries.clear();bytes=0;waiting?.({done:true});waiting=undefined;};
  return {
    push(command) {
      if(closed)throw Error('terminal_attachment_unavailable');
      const size=Buffer.byteLength(JSON.stringify(command),'utf8');
      if(command.sequence!==sequence+1)throw Error('terminal_input_sequence');
      if(size>maxBytes-bytes)throw Error('terminal_input_capacity');
      sequence=command.sequence;
      if(waiting){const resolve=waiting;waiting=undefined;resolve({done:false,value:command});}
      else{entries.set(sequence,{command,size});bytes+=size;}
    },
    close:end,
    [Symbol.asyncIterator]() {
      return {
        next() {
          const first=entries.entries().next();
          if(!first.done){const [key,value]=first.value;entries.delete(key);bytes-=value.size;return Promise.resolve({done:false,value:value.command});}
          if(closed)return Promise.resolve({done:true});
          if(waiting)return Promise.reject(Error('terminal_input_consumer_conflict'));
          return new Promise(resolve=>{waiting=resolve;});
        },
        return(){end();return Promise.resolve({done:true});},
      };
    },
  };
}

/** Each attachment owns a real native Remote Peer, retention hold and input queue. */
export function createTerminalAttachments({authorize,createPeer,gateway}) {
  const entries=new Map(),lifetime=new AbortController();
  const key=(owner,session,id)=>JSON.stringify([owner,session,id]);
  function close(entry) {
    if(entry.closing)return entry.closing;
    entry.closing=Promise.resolve().then(async()=>{
      entry.signal.removeEventListener('abort',entry.aborted);
      entry.abort.abort();entry.queue.close();
      const results=await Promise.allSettled([()=>entry.iterator?.return?.(),()=>entry.hold?.return?.(),()=>entry.peer?.dispose?.()]
        .map(dispose=>Promise.resolve().then(dispose)));
      if(results.some(result=>result.status==='rejected'))throw Error('terminal_attachment_cleanup_failed');
      if(entries.get(entry.key)===entry)entries.delete(entry.key);
    });
    return entry.closing;
  }
  return Object.freeze({
    async attach(owner,session,terminal,input,signal) {
      const packet=validateTerminalAttachment(input),abort=new AbortController();
      const active=AbortSignal.any([signal,abort.signal,lifetime.signal]);
      const source=authorize(owner,session,packet.host_instance,active),remote=gateway?.();
      if(typeof remote?.stream!=='function'||typeof createPeer!=='function'||typeof source.controller?.retain!=='function'
        ||typeof source.controller.environment!=='function')throw Error('terminal_attachment_unavailable');
      const identity=key(owner,session,packet.attachment_id);
      if(entries.has(identity))throw Error('terminal_attachment_conflict');
      if(entries.size>=32)throw Error('terminal_attachment_capacity');
      const limits=source.controller.environment(source.agent,active);
      if(!['maxBufferedBytes','maxInputBytes','maxCols','maxRows'].every(name=>Number.isSafeInteger(limits[name])&&limits[name]>0))throw Error('terminal_attachment_unavailable');
      const entry={key:identity,terminal,packet,source,limits,queue:inputQueue(limits.maxBufferedBytes),abort,signal:active,
        peer:undefined,hold:undefined,iterator:undefined,closing:undefined,aborted:undefined,ready:false};
      entries.set(identity,entry);
      entry.aborted=()=>{void close(entry).catch(()=>{});};
      active.addEventListener('abort',entry.aborted,{once:true});
      try {
        entry.peer=createPeer();
        entry.hold=source.controller.retain(session,terminal,active)[Symbol.asyncIterator]();
        const held=await entry.hold.next();
        if(held.done||held.value?.type!=='retained')throw Error('terminal_attachment_unavailable');
        source.check();
        const stream=await remote.stream({namespace:'terminal',method:'attach',args:{agentId:session,id:terminal},
          peer:entry.peer,signal:active,uplink:entry.queue,uplinkWindow:{maxBytes:limits.maxBufferedBytes,frameOverheadBytes:0}});
        entry.iterator=stream[Symbol.asyncIterator]();
        if(active.aborted){await entry.iterator.return?.();active.throwIfAborted();}
        source.check();
        const first=await entry.iterator.next();
        if(first.done||first.value?.type!=='snapshot')throw Error('terminal_frame_invalid');
        const baseline=projectTerminalFrame(first.value,session,terminal);
        source.check();entry.ready=true;
        const attached=validateTerminalAttached({protocol:1,type:'attached',session_id:session,terminal_id:terminal,
          ...packet,execution_authorized:false},{...packet,session_id:session,terminal_id:terminal});
        return (async function*(){
          try {
            source.check();yield attached;yield baseline;
            while(true){const next=await entry.iterator.next();if(next.done)return;source.check();yield projectTerminalFrame(next.value,session,terminal);}
          }finally{await close(entry);}
        })();
      }catch(error){await close(entry);throw error;}
    },
    input(owner,session,terminal,attachmentId,input,signal) {
      signal.throwIfAborted();
      const packet=validateTerminalInputPacket(input),entry=entries.get(key(owner,session,attachmentId));
      if(!entry||!entry.ready||entry.terminal!==terminal||entry.packet.host_instance!==packet.host_instance||entry.signal.aborted)throw Error('terminal_attachment_unavailable');
      authorize(owner,session,packet.host_instance,signal);entry.source.check();
      const command=packet.command;
      if(command.type==='write'&&Buffer.byteLength(command.data,'utf8')>entry.limits.maxInputBytes
        ||command.type==='resize'&&(command.cols>entry.limits.maxCols||command.rows>entry.limits.maxRows))throw Error('terminal_input_invalid');
      entry.queue.push(command);
      return validateTerminalQueued({protocol:1,state:'queued',attachment_id:attachmentId,sequence:command.sequence,execution_authorized:false},attachmentId,command.sequence);
    },
    async close() {
      lifetime.abort();
      const results=await Promise.allSettled([...entries.values()].map(close));
      if(results.some(result=>result.status==='rejected'))throw Error('terminal_attachment_cleanup_failed');
    },
  });
}
