import {useEffect,useState} from 'react';
import {request} from './client';
import {validateTerminalInventory,type TerminalInventory} from '../../packages/gateway/src/terminal/inventory.js';

const states={running:'运行中',exited:'已退出',failed:'失败'} as const;

/** Load retained native metadata only while the owning conversation panel is open. */
export default function ConversationTerminals({conversationId,runId}:{conversationId:string;runId:string}) {
  const [open,setOpen]=useState(false),[revision,setRevision]=useState(0);
  const [inventory,setInventory]=useState<TerminalInventory>(),[loading,setLoading]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    setInventory(undefined);setError('');setLoading(open);
    if(!open)return;
    const abort=new AbortController();
    void request<TerminalInventory>(`/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/terminals`,'GET',undefined,undefined,abort.signal)
      .then(value=>{
        const parsed=validateTerminalInventory(value,value?.session_id);
        if(!abort.signal.aborted)setInventory(parsed);
      }).catch(reason=>{
        if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'无法读取原生终端');
      }).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>abort.abort();
  },[open,revision,conversationId,runId]);
  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>会话终端</summary>
    <button type="button" disabled={loading} onClick={()=>setRevision(value=>value+1)}>刷新终端清单</button>
    {loading&&<p role="status">正在读取原生终端…</p>}
    {error&&<p role="alert">{error}</p>}
    {inventory&&<>
      <p>原生会话 <code>{inventory.session_id}</code> · 当前 Host 保留的终端</p>
      {!inventory.terminals.length&&<p role="status">该原生会话当前没有保留的终端。</p>}
      <ul>{inventory.terminals.map(terminal=><li key={terminal.id}>
        <strong>{terminal.title}</strong> · {states[terminal.state]}
        {terminal.exitCode!==null&&<> · 退出码 {terminal.exitCode}</>}
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
