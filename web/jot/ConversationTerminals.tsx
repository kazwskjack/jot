import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ApiError,request,taskDraftScope} from './client';
import {useMutationReceipt} from '../workbench/useMutationReceipt';
import {TerminalCommandStore,pendingTerminalRuns} from './terminal-command-store.mjs';
import {validateTerminalInventory,type TerminalInventory} from '../../packages/gateway/src/terminal/inventory.js';
import {validateTerminalOptions,validateTerminalCommand,validateTerminalReceipt,type TerminalOptions,type TerminalCommand,type TerminalReceipt} from '../../packages/gateway/src/terminal/control.js';

const states={running:'运行中',exited:'已退出',failed:'失败'} as const;

/** Native user terminals retain their original Session ownership and command receipts. */
export default function ConversationTerminals({conversationId,runId}:{conversationId:string;runId:string}) {
  const [revision,setRevision]=useState(0),[notice,setNotice]=useState(''),scope=taskDraftScope();
  const refresh=useCallback((message?:string)=>{if(message)setNotice(message);setRevision(value=>value+1);},[]);
  const history=useMemo(()=>{
    try {
      const runs:string[]=pendingTerminalRuns(window.sessionStorage,scope,conversationId);
      return {runs:runs.filter(id=>id!==runId),error:''};
    }
    catch(reason){return {runs:[] as string[],error:reason instanceof Error?reason.message:'无法恢复历史终端请求'};}
  },[scope,conversationId,runId,revision]);
  useEffect(()=>{const changed=()=>refresh();window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[refresh]);
  return <>
    <TerminalPanel key={runId} conversationId={conversationId} runId={runId} onSettled={refresh}/>
    {history.error&&<p role="alert">{history.error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {history.runs.length>0&&<details><summary>历史运行的未结终端请求</summary>
      {history.runs.map(id=><TerminalPanel key={id} conversationId={conversationId} runId={id} historical onSettled={refresh}/>)}
    </details>}
  </>;
}

function TerminalPanel({conversationId,runId,historical=false,onSettled}:{conversationId:string;runId:string;historical?:boolean;onSettled:(message?:string)=>void}) {
  const [open,setOpen]=useState(false),[revision,setRevision]=useState(0);
  const [inventory,setInventory]=useState<TerminalInventory>(),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [options,setOptions]=useState<TerminalOptions>(),[optionsError,setOptionsError]=useState('');
  const [shell,setShell]=useState(''),[cols,setCols]=useState(80),[rows,setRows]=useState(24),[busy,setBusy]=useState(false),[commandError,setCommandError]=useState('');
  const [journal]=useState(()=>{
    try {
      const store=new TerminalCommandStore(window.sessionStorage,taskDraftScope(),conversationId,runId);
      const saved=store.read();
      return {store,error:'',endingWait:saved?.endingWait??false,pending:saved?.command.body as TerminalCommand|undefined};
    }catch(reason){return {store:null,error:reason instanceof Error?reason.message:'无法保留原终端请求',endingWait:false,pending:undefined};}
  });
  const [endingWait,setEndingWait]=useState(journal.endingWait);
  const [pendingCommand,setPendingCommand]=useState(journal.pending);
  const commandKey=useRef(''),alive=useRef(true);
  const writer=useMutationReceipt(journal.store,()=>commandKey.current,async(path,method,body,key)=>{
    const command=validateTerminalCommand(body);
    let receipt;
    try {
      const ending=journal.store?.read()?.endingWait===true;
      const value=await request<TerminalReceipt>(path+'/'+encodeURIComponent(command.request_id)+(ending?'/end-wait':'/reconcile'),'POST',command,key);
      receipt=validateTerminalReceipt(value,command,value?.session_id);
    }catch{throw Error('终端回执暂时无法核对，原请求已保留。');}
    if(receipt.state==='completed'||receipt.state==='wait_ended_unknown')return receipt;
    if(receipt.state==='rejected')throw new ApiError(receipt.rejection!.status,receipt.rejection!.error_code);
    if(receipt.state==='not_admitted') {
      let value;
      try{value=validateTerminalInventory(await request<unknown>(path,method,body,key),receipt.session_id);}
      catch(reason){
        if(reason instanceof ApiError&&reason.message==='TERMINAL_WAIT_ENDED_UNKNOWN')throw Error('原请求已结束等待，请重读原回执。');
        throw reason;
      }
      return validateTerminalReceipt({...receipt,state:'completed',inventory:value},command,receipt.session_id);
    }
    throw Error(receipt.state==='pending'?'原终端操作仍在处理中，请稍后核对。':'原终端操作结果仍未知，原请求已保留。');
  });
  const path=`/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/terminals`;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    setInventory(undefined);setOptions(undefined);setError('');setOptionsError('');setLoading(open);
    if(!open)return;
    const abort=new AbortController();
    void Promise.allSettled([
      request<TerminalInventory>(path,'GET',undefined,undefined,abort.signal).then(value=>validateTerminalInventory(value,value?.session_id)),
      request<TerminalOptions>(path+'/options','GET',undefined,undefined,abort.signal).then(value=>validateTerminalOptions(value,value?.session_id)),
    ]).then(([listed,configured])=>{
      if(abort.signal.aborted)return;
      if(listed.status==='fulfilled')setInventory(listed.value);
      else setError(listed.reason instanceof Error?listed.reason.message:'无法读取原生终端');
      if(configured.status==='fulfilled'&&(listed.status!=='fulfilled'||configured.value.session_id===listed.value.session_id)){
        const value=configured.value;setOptions(value);setInventory(value.inventory);
        setCols(current=>Math.min(current,value.environment.maxCols));setRows(current=>Math.min(current,value.environment.maxRows));
        setShell(current=>value.shells.some(item=>item.path===current)?current:'');
      }else setOptionsError('原生终端控制暂不可用。需要当前 Host 中已驻留的原生会话。');
      setLoading(false);
    });
    return()=>abort.abort();
  },[open,revision,path]);
  async function submit(command?:TerminalCommand) {
    if(busy||journal.error||command&&(!inventory||writer.pending)||!command&&!writer.pending)return;
    if(command){commandKey.current=command.request_id;setEndingWait(false);setPendingCommand(command);}
    setBusy(true);setCommandError('');
    let outcome='';
    try {
      const original=command??validateTerminalCommand(journal.store?.read()?.command.body);
      const value=await writer.submit(path+'/commands','POST',command??{});
      const receipt=validateTerminalReceipt(value,original,(value as TerminalReceipt)?.session_id);
      if(receipt.state==='wait_ended_unknown')outcome=`请求 ${original.request_id} 已结束等待，执行结果保留为未知。已发出的操作仍可能完成。`;
      else if(receipt.state==='completed'){
        if(alive.current)setInventory(receipt.inventory!);
        if(historical)outcome='历史终端请求已确认完成。';
      }
    } catch(reason) {
      if(alive.current)setCommandError(reason instanceof Error?reason.message:'终端操作结果尚未确认');
      if(historical)outcome=reason instanceof Error?reason.message:'历史终端请求结果尚未确认';
    } finally {
      if(alive.current){setBusy(false);setRevision(value=>value+1);onSettled(outcome);}
    }
  }
  async function endWait() {
    if(busy||!writer.pending||journal.error||!journal.store)return;
    try {
      const original=journal.store.read()?.command;
      journal.store.requestEndWait(original);
      setEndingWait(true);
      await submit();
    }catch(reason){if(alive.current)setCommandError(reason instanceof Error?reason.message:'无法保留结束等待请求');}
  }
  const dimensionsValid=Boolean(options&&Number.isSafeInteger(cols)&&cols>=2&&cols<=options.environment.maxCols
    &&Number.isSafeInteger(rows)&&rows>0&&rows<=options.environment.maxRows);
  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>{historical?`历史运行终端请求 · ${runId}`:'会话终端'}</summary>
    <button type="button" disabled={loading} onClick={()=>setRevision(value=>value+1)}>刷新终端清单</button>
    {loading&&<p role="status">正在读取原生终端…</p>}
    {error&&<p role="alert">{error}</p>}
    {commandError&&<p role="alert">{commandError}</p>}
    {journal.error&&<p role="alert">{journal.error}</p>}
    {optionsError&&<p role="status">{optionsError}</p>}
    {writer.pending&&<div role="status">
      <p>原终端请求等待回执。</p>
      {pendingCommand&&<p>请求 <code>{pendingCommand.request_id}</code> · {pendingCommand.action==='create'?'创建':'关闭'} <code>{pendingCommand.terminal_id}</code></p>}
      <button type="button" disabled={busy||Boolean(journal.error)} onClick={()=>void submit()}>{endingWait?'重读结束等待回执':'重读原请求回执'}</button>
      <button type="button" disabled={busy||endingWait||Boolean(journal.error)} onClick={()=>void endWait()}>保留未知并结束等待</button>
      <p>结束等待后，原请求的执行结果继续保留。已发出的操作仍可能完成。</p>
    </div>}
    {options&&<fieldset disabled={busy||writer.pending||loading||Boolean(journal.error)}>
      <legend>创建用户终端</legend>
      <p>用户终端使用执行环境的系统用户权限。</p>
      <p>初始目录 <code style={{overflowWrap:'anywhere'}}>{options.environment.cwd}</code></p>
      <label>Shell <select value={shell} onChange={event=>setShell(event.currentTarget.value)}>
        <option value="">执行环境默认 Shell</option>
        {options.shells.map((item,index)=><option key={`${index}:${item.path}`} value={item.path}>{item.name} · {item.path}</option>)}
      </select></label>
      <label>列 <input type="number" min={2} max={options.environment.maxCols} value={cols} onChange={event=>setCols(Number(event.currentTarget.value))}/></label>
      <label>行 <input type="number" min={1} max={options.environment.maxRows} value={rows} onChange={event=>setRows(Number(event.currentTarget.value))}/></label>
      <button type="button" disabled={!inventory||!dimensionsValid} onClick={()=>void submit({action:'create',request_id:crypto.randomUUID(),
        terminal_id:'jot-'+crypto.randomUUID(),host_instance:options.host_instance,cols,rows,shell_path:shell||null})}>创建终端</button>
    </fieldset>}
    {inventory&&<>
      <p>原生会话 <code>{inventory.session_id}</code> · 当前 Host 保留的终端</p>
      {!inventory.terminals.length&&<p role="status">该原生会话当前没有保留的终端。</p>}
      <ul>{inventory.terminals.map(terminal=><li key={terminal.id}>
        <strong>{terminal.title}</strong> · {states[terminal.state]}
        {terminal.exitCode!==null&&<> · 退出码 {terminal.exitCode}</>}
        {options&&<button type="button" disabled={busy||writer.pending||loading||Boolean(journal.error)} onClick={()=>void submit({action:'close',request_id:crypto.randomUUID(),
          terminal_id:terminal.id,host_instance:options.host_instance})}>关闭 {terminal.title}</button>}
        <dl>
          <dt>终端身份</dt><dd><code>{terminal.id}</code></dd>
          <dt>Shell</dt><dd style={{overflowWrap:'anywhere'}}>{terminal.shell.name} <code>{terminal.shell.path}</code></dd>
          <dt>参数</dt><dd><code style={{overflowWrap:'anywhere'}}>{JSON.stringify(terminal.shell.args)}</code></dd>
          <dt>初始目录</dt><dd style={{overflowWrap:'anywhere'}}><code>{terminal.cwd}</code></dd>
          <dt>尺寸</dt><dd>{terminal.cols} 列 × {terminal.rows} 行</dd>
        </dl>
      </li>)}</ul>
    </>}
  </details>;
}
