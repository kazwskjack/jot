import {useEffect,useRef,useState} from 'react';
import {request,requestTerminalStream} from './client';
import {loadTerminalAssets,type TerminalApi} from './terminal-assets';
import {TerminalInputSender} from './terminal-input-sender';
import {projectTerminalFrame,validateTerminalAttached,validateTerminalQueued} from '../../packages/gateway/src/terminal/stream.js';
import type {TerminalOptions} from '../../packages/gateway/src/terminal/control.js';
import type {TerminalInfo} from '../../packages/gateway/src/terminal/inventory.js';

type Props={conversationId:string;runId:string;terminal:TerminalInfo;options:TerminalOptions;
  onClose:()=>void;onNotice:(message:string)=>void;onPendingChange:(value:boolean)=>void;onActiveChange:(value:boolean)=>void};
type Live={abort:AbortController;terminal:TerminalApi;sender?:TerminalInputSender;writable:boolean;fit:()=>void};

async function readFrames(stream:ReadableStream<Uint8Array>,signal:AbortSignal,consume:(value:unknown)=>Promise<void>) {
  const reader=stream.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
  let fragments:string[]=[];
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
  async function accept(text:string) {
    let start=0,end:number;
    while((end=text.indexOf('\n',start))!==-1){
      fragments.push(text.slice(start,end));const line=fragments.join('');fragments=[];start=end+1;
      if(signal.aborted)throw Error('终端连接已关闭');
      if(line.trim())await consume(JSON.parse(line));
    }
    if(start<text.length)fragments.push(text.slice(start));
  }
  try{
    while(!signal.aborted){const part=await reader.read();if(part.done)break;await accept(decoder.decode(part.value,{stream:true}));}
    if(!signal.aborted){await accept(decoder.decode());if(fragments.length)throw Error('终端数据流不完整');throw Error('终端连接已结束，可重新连接。');}
  }finally{signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
}

function renderText(terminal:TerminalApi,text:string,signal:AbortSignal) {
  return new Promise<void>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(Error('终端连接已关闭'));};
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    try{terminal.write(text,()=>{signal.removeEventListener('abort',abort);resolve();});}
    catch(reason){signal.removeEventListener('abort',abort);reject(reason);}
  });
}

/** Browser rendering follows the native screen, ownership and provider acknowledgements. */
export default function NativeTerminalView(props:Props) {
  const {conversationId,runId,terminal,options}=props;
  const callbacks=useRef(props);callbacks.current=props;
  const host=useRef<HTMLDivElement>(null),live=useRef<Live|undefined>(undefined);
  const modifiers=useRef({ctrl:false,alt:false});
  const [keys,setKeys]=useState(modifiers.current),[revision,setRevision]=useState(0);
  const [status,setStatus]=useState('正在连接原生终端…'),[notice,setNotice]=useState(''),[writable,setWritable]=useState(false);
  const [info,setInfo]=useState(terminal),[pending,setPending]=useState(false);
  function resetKeys(){modifiers.current={ctrl:false,alt:false};setKeys(modifiers.current);}
  function toggleKey(key:'ctrl'|'alt'){modifiers.current={...modifiers.current,[key]:!modifiers.current[key]};setKeys(modifiers.current);live.current?.terminal.focus();}
  function applyKeys(data:string) {
    const {ctrl,alt}=modifiers.current;resetKeys();
    if(ctrl&&data.length===1){const code=data.toUpperCase().charCodeAt(0);if(code>=64&&code<=95)data=String.fromCharCode(code-64);else if(data===' ')data='\x00';else if(data==='?')data='\x7f';}
    else if((ctrl||alt)&&/^\x1b\[[ABCD]$/.test(data))return `\x1b[1;${1+(alt?2:0)+(ctrl?4:0)}${data.at(-1)}`;
    return alt?'\x1b'+data:data;
  }
  async function copySelection() {
    const current=live.current;if(!current||!current.terminal.hasSelection())return;
    const text=current.terminal.getSelection();
    try{await navigator.clipboard.writeText(text);if(live.current===current&&!current.abort.signal.aborted)setNotice('已复制所选终端文本。');}
    catch{if(live.current===current&&!current.abort.signal.aborted)setNotice('无法访问剪贴板，请使用系统复制操作。');}
  }
  async function paste() {
    const current=live.current;if(!current?.writable||current.abort.signal.aborted)return;
    resetKeys();
    try{const text=await navigator.clipboard.readText();if(live.current===current&&!current.abort.signal.aborted&&current.writable){resetKeys();current.terminal.paste(text);}}
    catch{if(live.current===current&&!current.abort.signal.aborted)setNotice('无法读取剪贴板，请使用系统粘贴操作。');}
  }
  const actions=useRef({copySelection,paste,applyKeys});actions.current={copySelection,paste,applyKeys};
  useEffect(()=>{
    callbacks.current.onActiveChange(true);
    return()=>callbacks.current.onActiveChange(false);
  },[]);
  useEffect(()=>{
    const abort=new AbortController(),signal=abort.signal;
    let current:Live|undefined,observer:ResizeObserver|undefined,fitTimer:ReturnType<typeof setTimeout>|undefined;
    let opening:ReturnType<typeof setTimeout>|undefined,disposed=false;
    const notifyPending=(value:boolean)=>{if(!disposed){setPending(value);callbacks.current.onPendingChange(value);}};
    const dispose=()=>{
      if(disposed)return;disposed=true;
      const unknown=current?.sender?.unconfirmedCount??0;
      abort.abort();clearTimeout(opening);clearTimeout(fitTimer);observer?.disconnect();
      window.removeEventListener('resize',scheduleFit);window.visualViewport?.removeEventListener('resize',scheduleFit);
      current?.sender?.close();callbacks.current.onPendingChange(false);
      if(live.current===current)live.current=undefined;
      try{current?.terminal.dispose();}
      catch{callbacks.current.onNotice('终端渲染器释放未能确认，原生附着已取消。');}
      if(unknown)callbacks.current.onNotice('连接已关闭，尚未确认的终端输入结果未知。重新连接后请先查看屏幕。');
    };
    function fail(message:string){if(disposed)return;dispose();setWritable(false);setPending(false);setStatus('连接已断开');setNotice(message);callbacks.current.onNotice(message);}
    function scheduleFit(){clearTimeout(fitTimer);fitTimer=setTimeout(()=>current?.fit(),50);}
    setWritable(false);setPending(false);setNotice('');setStatus('正在连接原生终端…');resetKeys();
    opening=setTimeout(()=>fail('原生终端连接超时，可重新连接。'),30000);
    void (async()=>{
      const libraries=await loadTerminalAssets();if(signal.aborted||!host.current)return;
      const view=new libraries.Terminal({cursorBlink:true,fontSize:14,fontFamily:'Menlo, Monaco, "Courier New", monospace',
        allowProposedApi:true,allowTransparency:false,convertEol:false,tabStopWidth:4,macOptionIsMeta:true,
        macOptionClickForcesSelection:true,screenReaderMode:true,disableStdin:true,scrollback:options.environment.scrollback,
        cols:terminal.cols,rows:terminal.rows,theme:{background:'#101318',foreground:'#e5e7eb',cursor:'#f9fafb',selectionBackground:'#475569'}});
      current={abort,terminal:view,writable:false,fit:()=>{}};live.current=current;
      const fit=new libraries.FitAddon();view.loadAddon(fit);
      view.loadAddon(new libraries.WebLinksAddon((_event,uri)=>{try{const url=new URL(uri);if(url.protocol==='https:'||url.protocol==='http:')window.open(url.href,'_blank','noopener,noreferrer');}catch{}}));
      view.open(host.current);
      let gl:InstanceType<typeof libraries.WebglAddon>|undefined;
      try{
        const addon=new libraries.WebglAddon();gl=addon;
        addon.onContextLoss(()=>{addon.dispose();if(!signal.aborted)setNotice('WebGL 上下文已释放，已切换默认终端渲染。');});
        view.loadAddon(addon);
      }catch{gl?.dispose();setNotice('当前环境使用默认终端渲染。');}
      const active=current;
      view.attachCustomKeyEventHandler(event=>{
        if(event.type!=='keydown'||!(event.ctrlKey||event.metaKey)||event.altKey)return true;
        if(event.key.toLowerCase()==='c'&&view.hasSelection()){void actions.current.copySelection();return false;}
        if(event.key.toLowerCase()==='v'){event.preventDefault();void actions.current.paste();return false;}
        return true;
      });
      view.onData(data=>{
        if(signal.aborted||!active.writable)return;
        // Parser replies and bracketed paste keep their original control sequences.
        const text=data.length===1&&data.charCodeAt(0)>=32?actions.current.applyKeys(data):data;
        active.sender?.write(text);
      });
      const path=`/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/terminals/${encodeURIComponent(terminal.id)}`;
      const packet={attachment_id:crypto.randomUUID(),host_instance:options.host_instance};
      let attached=false,baseline=false,sequence=0,requestedSize='';
      active.fit=()=>{
        if(signal.aborted||!baseline||!active.writable)return;
        const dimensions=fit.proposeDimensions();if(!dimensions)return;
        const cols=Math.max(2,Math.min(options.environment.maxCols,dimensions.cols)),rows=Math.max(1,Math.min(options.environment.maxRows,dimensions.rows));
        const size=`${cols}:${rows}`;if(size===requestedSize||cols===view.cols&&rows===view.rows)return;
        if(active.sender?.resize(cols,rows))requestedSize=size;
      };
      observer=new ResizeObserver(scheduleFit);observer.observe(host.current);
      window.addEventListener('resize',scheduleFit);window.visualViewport?.addEventListener('resize',scheduleFit);
      const stream=await requestTerminalStream(path+'/attach',packet,signal);
      await readFrames(stream,signal,async value=>{
        if(signal.aborted)return;
        if(!attached){validateTerminalAttached(value,{...packet,session_id:options.session_id,terminal_id:terminal.id});attached=true;return;}
        const frame=projectTerminalFrame(value,options.session_id,terminal.id);
        if(!baseline&&frame.type!=='snapshot'||baseline&&frame.type==='snapshot')throw Error('终端屏幕基线不匹配');
        if(frame.type==='snapshot'){
          view.reset();view.resize(frame.info.cols,frame.info.rows);await renderText(view,frame.screen,signal);if(signal.aborted)return;
          sequence=frame.sequence;baseline=true;
          active.sender=new TerminalInputSender(options.environment,frame.inputWindow??{maxBytes:options.environment.maxBufferedBytes,frameOverheadBytes:0},
            async command=>{const result=await request<unknown>(path+'/attachments/'+packet.attachment_id+'/input','POST',
              {host_instance:packet.host_instance,command},crypto.randomUUID(),signal,10000);validateTerminalQueued(result,packet.attachment_id,command.sequence);},
            notifyPending,message=>{if(!signal.aborted)setNotice(message);},()=>fail('输入发送结果尚未确认，连接已关闭。请重连并核对屏幕后再操作。'));
          clearTimeout(opening);
        }else if(frame.type==='output'){
          if(frame.sequence!==sequence+1)throw Error('终端输出序号不连续，请重新连接恢复屏幕。');
          await renderText(view,frame.data,signal);sequence=frame.sequence;return;
        }else if(frame.type==='ack'){
          active.sender!.acknowledge(frame.sequence,frame.refusal);
          if(frame.refusal){active.writable=false;view.options.disableStdin=true;setWritable(false);setStatus('只读终端');}
          scheduleFit();
          return;
        }
        if(signal.aborted)return;
        setInfo(frame.info);view.resize(frame.info.cols,frame.info.rows);
        active.sender!.setWritable(frame.writable&&frame.info.state==='running');active.writable=active.sender!.canWrite;
        view.options.disableStdin=!active.writable;setWritable(active.writable);
        setStatus(frame.info.state==='running'?(active.writable?'已连接 · 可输入':'已连接 · 只读，重连可申请控制权'):`进程已结束${frame.info.exitCode===null?'':` · 退出码 ${frame.info.exitCode}`}`);
        scheduleFit();
      });
    })().catch(reason=>{if(!signal.aborted)fail(reason instanceof Error?reason.message:'无法连接原生终端');});
    return dispose;
  },[conversationId,runId,terminal.id,options,revision]);
  function sendKey(data:string){const current=live.current;if(current?.writable&&!current.abort.signal.aborted){current.sender?.write(applyKeys(data));current.terminal.focus();}}
  return <section aria-label={`交互终端 ${terminal.title}`}>
    <p role="status">{status} · {info.cols} 列 × {info.rows} 行{pending?' · 输入等待原生确认':''}</p>
    {notice&&<p role="status" style={{overflowWrap:'anywhere'}}>{notice}</p>}
    <div role="group" aria-label="终端操作" style={{display:'flex',flexWrap:'wrap',gap:6}}>
      <button type="button" onClick={()=>setRevision(value=>value+1)}>重新连接</button>
      <button type="button" onClick={()=>live.current?.terminal.focus()}>聚焦终端</button>
      <button type="button" onClick={()=>void copySelection()}>复制所选文本</button>
      <button type="button" disabled={!writable} onClick={()=>void paste()}>粘贴</button>
      <button type="button" disabled={!writable} onClick={()=>live.current?.fit()}>适应尺寸</button>
      <button type="button" onClick={()=>live.current?.terminal.scrollToBottom()}>滚动到底部</button>
      <button type="button" onClick={props.onClose}>断开视图</button>
    </div>
    <div ref={host} aria-label="原生终端屏幕" style={{height:'min(55vh,480px)',minHeight:180,minWidth:0,overflow:'hidden',marginTop:8,background:'#101318'}}/>
    <div role="group" aria-label="移动终端快捷键" style={{display:'flex',flexWrap:'wrap',gap:6,marginTop:8}}>
      <button type="button" disabled={!writable} aria-pressed={keys.ctrl} onPointerDown={event=>event.preventDefault()} onClick={()=>toggleKey('ctrl')}>Ctrl</button>
      <button type="button" disabled={!writable} aria-pressed={keys.alt} onPointerDown={event=>event.preventDefault()} onClick={()=>toggleKey('alt')}>Alt</button>
      {([['Esc','\x1b'],['Tab','\t'],['Shift+Tab','\x1b[Z'],['↑','\x1b[A'],['↓','\x1b[B'],['←','\x1b[D'],['→','\x1b[C']] as const).map(([label,data])=>
        <button type="button" key={label} disabled={!writable} aria-label={`发送 ${label}`} onPointerDown={event=>event.preventDefault()} onClick={()=>sendKey(data)}>{label}</button>)}
    </div>
  </section>;
}
