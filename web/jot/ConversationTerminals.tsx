import {useEffect,useRef,useState} from 'react';
import {request} from './client';
import {useMutationReceipt} from '../workbench/useMutationReceipt';
import {validateTerminalInventory,type TerminalInventory} from '../../packages/gateway/src/terminal/inventory.js';
import {validateTerminalOptions,type TerminalOptions,type TerminalCommand} from '../../packages/gateway/src/terminal/control.js';

const states={running:'运行中',exited:'已退出',failed:'失败'} as const;

/** Native user terminals retain their original Session ownership and command receipts. */
export default function ConversationTerminals({conversationId,runId}:{conversationId:string;runId:string}) {
  const [open,setOpen]=useState(false),[revision,setRevision]=useState(0);
  const [inventory,setInventory]=useState<TerminalInventory>(),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [options,setOptions]=useState<TerminalOptions>(),[optionsError,setOptionsError]=useState('');
  const [shell,setShell]=useState(''),[cols,setCols]=useState(80),[rows,setRows]=useState(24),[busy,setBusy]=useState(false),[commandError,setCommandError]=useState('');
  const commandKey=useRef(''),alive=useRef(true);
  const writer=useMutationReceipt(undefined,()=>commandKey.current,async(path,method,body,key)=>
    validateTerminalInventory(await request<unknown>(path,method,body,key),inventory?.session_id??''));
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
    if(busy||!inventory||command&&writer.pending)return;
    if(command)commandKey.current=command.request_id;
    setBusy(true);setCommandError('');
    try {
      const value=await writer.submit(path+'/commands','POST',command??{});
      const parsed=validateTerminalInventory(value,inventory.session_id);
      if(alive.current)setInventory(parsed);
    } catch(reason) {
      if(alive.current)setCommandError(reason instanceof Error?reason.message:'终端操作结果尚未确认');
    } finally {
      if(alive.current){setBusy(false);setRevision(value=>value+1);}
    }
  }
  const dimensionsValid=Boolean(options&&Number.isSafeInteger(cols)&&cols>0&&cols<=options.environment.maxCols
    &&Number.isSafeInteger(rows)&&rows>0&&rows<=options.environment.maxRows);
  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>会话终端</summary>
    <button type="button" disabled={loading} onClick={()=>setRevision(value=>value+1)}>刷新终端清单</button>
    {loading&&<p role="status">正在读取原生终端…</p>}
    {error&&<p role="alert">{error}</p>}
    {commandError&&<p role="alert">{commandError}</p>}
    {optionsError&&<p role="status">{optionsError}</p>}
    {writer.pending&&<p role="status">原终端请求等待回执。<button type="button" disabled={busy||!inventory} onClick={()=>void submit()}>重读原请求回执</button></p>}
    {options&&<fieldset disabled={busy||writer.pending||loading}>
      <legend>创建用户终端</legend>
      <p>用户终端使用执行环境的系统用户权限。</p>
      <p>初始目录 <code style={{overflowWrap:'anywhere'}}>{options.environment.cwd}</code></p>
      <label>Shell <select value={shell} onChange={event=>setShell(event.currentTarget.value)}>
        <option value="">执行环境默认 Shell</option>
        {options.shells.map((item,index)=><option key={`${index}:${item.path}`} value={item.path}>{item.name} · {item.path}</option>)}
      </select></label>
      <label>列 <input type="number" min={1} max={options.environment.maxCols} value={cols} onChange={event=>setCols(Number(event.currentTarget.value))}/></label>
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
        {options&&<button type="button" disabled={busy||writer.pending||loading} onClick={()=>void submit({action:'close',request_id:crypto.randomUUID(),
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
