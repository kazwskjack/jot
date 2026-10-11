import React,{useEffect,useRef,useState} from 'react';
import type {ChannelBinding} from './types';
import {request} from '../jot/client';
import {EmailBindingCommands} from './email-binding-ui.mjs';
export default function EmailBindingPanel({bindings,onUpdated}:{bindings:ChannelBinding[];onUpdated:()=>void}){
 const commands=useRef(new EmailBindingCommands(request));
 const [address,setAddress]=useState(''),[code,setCode]=useState(''),[id,setId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [confirmedId,setConfirmedId]=useState('');
 const pending=bindings.filter(binding=>binding.channel==='email'&&binding.status==='pending');
 useEffect(()=>{if(!commands.current.confirmPending&&!pending.some(binding=>binding.channel_binding_id===id))setId(pending[0]?.channel_binding_id??'');},[bindings,id]);
 useEffect(()=>{if(confirmedId&&bindings.some(binding=>binding.channel_binding_id===confirmedId&&binding.status==='revoked')){setNotice('');setConfirmedId('');}},[bindings,confirmedId]);
 const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(error){setError(error instanceof Error?error.message:'请求未完成');}finally{setBusy(false);}};
 const begin=(event:React.FormEvent)=>{event.preventDefault();void run(async()=>{
  const result=await commands.current.begin(address);setAddress('');setId(result.channel_binding_id);onUpdated();
  setNotice(result.delivery_status==='accepted'?'验证邮件已提交，请查收并粘贴完整验证码。':'邮件发送结果待核对。若已收到验证码可继续确认，不会自动重复发信。');
 });};
 const confirm=(event:React.FormEvent)=>{event.preventDefault();void run(async()=>{
  const result=await commands.current.confirm(id,code);setConfirmedId(result.channel_binding_id);setCode('');setId('');onUpdated();setNotice('邮箱已验证，可在任务通知设置中选择。');
 });};
 return <section aria-label="邮箱绑定"><h5>绑定邮箱</h5>
 <p className="wb-hint">验证邮件只发送到你填写的邮箱。验证后还需在任务通知设置中选择此渠道。</p>
 {error&&<p className="wb-error" role="alert">{error}</p>}{notice&&<p className="wb-status" role="status">{notice}</p>}
 <form className="wb-form" aria-label="申请邮箱验证" onSubmit={begin}>
 <label>通知邮箱<input type="email" maxLength={254} required autoComplete="email" value={address} disabled={busy||commands.current.beginPending} onChange={event=>setAddress(event.target.value)}/></label>
 {commands.current.beginPending&&<p>申请结果待确认，重试沿用原邮箱，不会重复发信。</p>}
 <button type="submit" disabled={busy}>{commands.current.beginPending?'重试原邮箱申请':'发送验证邮件'}</button>
 </form>
 {(pending.length>0||commands.current.confirmPending)&&<form className="wb-form" aria-label="确认邮箱验证" onSubmit={confirm}>
 <fieldset disabled={busy||commands.current.confirmPending}><legend>确认收到的验证码</legend>
 <label>待验证邮箱<select required value={id} onChange={event=>{setId(event.target.value);setCode('');}}>{pending.map(binding=><option key={binding.channel_binding_id} value={binding.channel_binding_id}>邮箱 · {binding.channel_binding_id.slice(-6)}</option>)}</select></label>
 <label>邮箱验证码<input type="text" required minLength={43} maxLength={43} autoComplete="off" spellCheck={false} value={code} onChange={event=>setCode(event.target.value.trim())}/></label>
 </fieldset><small>有效期10分钟，最多5次错误；验证码不保存到浏览器存储。</small>
 {commands.current.confirmPending&&<p>确认结果待核对，重试沿用原验证码。</p>}
 <button type="submit" disabled={busy}>{commands.current.confirmPending?'重试原邮箱确认':'确认邮箱'}</button>
 </form>}
 <button type="button" disabled={busy} onClick={onUpdated}>刷新邮箱状态</button>
 </section>;
}
