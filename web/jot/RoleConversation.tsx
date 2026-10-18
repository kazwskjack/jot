import type {TaskSourceSelection} from '../workbench/types';
import {useMutationReceipt} from '../workbench/useMutationReceipt';
import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {request,follow,snapshot,base} from './client';
import {RoleChatController} from './conversation-controller.mjs';
import {UploadController} from './upload-controller.mjs';
import {messageFiles} from './message-files.mjs';
import InteractionCard from './InteractionCard';
import ConversationGoal from './ConversationGoal';
import VoiceInput from './VoiceInput';
import PromptComposer from './PromptComposer';
import {appendVoiceText} from './voice-draft-controller.mjs';
import {latestGoalRun} from './goal-controller.mjs';
import type {Artifact,Run,Capabilities,Preview,Conversation,ModelSelection} from './types';
const active=(run:Run)=>['queued','starting','running','waiting_user','waiting_approval','cancelling'].includes(run.status);
type ConversationProps={ordinary?:boolean;id:string;onClose:()=>void;onTaskSource?:(source:TaskSourceSelection)=>void};
export default function RoleConversation(props:ConversationProps){
 return <ConversationContent key={`${props.id}:${Boolean(props.ordinary)}`} {...props}/>;
}
function ConversationContent({id,onClose,onTaskSource,ordinary=false}:ConversationProps){
 const [,render]=useState(0),[draft,setDraft]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[expanded,setExpanded]=useState<Record<string,boolean>>({}),[maxBytes,setMaxBytes]=useState<number>(),[preview,setPreview]=useState<{name:string;text?:string;url?:string;unsupported?:boolean;truncated?:boolean}>();
 const [voice,setVoice]=useState<Capabilities['voice']>(),[voiceBusy,setVoiceBusy]=useState(false),draftRef=useRef(draft);
 const modelMutation=useMutationReceipt();
 const editDraft=useCallback((value:string)=>{draftRef.current=value;setDraft(value);},[]);
 const appendTranscript=useCallback((text:string)=>editDraft(appendVoiceText(draftRef.current,text)),[editDraft]);
 const [models,setModels]=useState<Capabilities['models']>([]),[conversation,setConversation]=useState<Conversation>(),fileInput=useRef<HTMLInputElement>(null);
 const controller=useMemo(()=>new RoleChatController(id,{request,follow,snapshot:async(conversationId:string,signal?:AbortSignal)=>{const value=await snapshot(conversationId,signal);if(!signal?.aborted)setConversation(value.conversation);return value;}},()=>render(n=>n+1)),[id]);
 const [goalMode,setGoalMode]=useState(false),[goalPending,setGoalPending]=useState(false);
 useEffect(()=>{setGoalMode(false);},[id,ordinary]);
 const uploads=useMemo(()=>new UploadController(id,{request},()=>render(n=>n+1)),[id]);
 useEffect(()=>{let mounted=true;controller.onChange=()=>{if(mounted)render(n=>n+1);};void controller.start();return()=>{mounted=false;controller.stop();};},[controller]);
 useEffect(()=>{let mounted=true;const abort=new AbortController();uploads.onChange=()=>{if(mounted)render(n=>n+1);};void request<Capabilities>('/capabilities','GET',undefined,undefined,abort.signal).then(value=>{if(mounted){setMaxBytes(value.limits.max_upload_bytes);setVoice(value.voice);setModels(value.models??[]);}}).catch(e=>{if(mounted)setError(e instanceof Error?e.message:'暂时无法读取服务能力');});return()=>{mounted=false;abort.abort();};},[uploads]);
 useEffect(()=>()=>{if(preview?.url)URL.revokeObjectURL(preview.url);},[preview]);
 useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(uploads.entries.length||controller.pendingMessage||goalPending||voiceBusy){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[uploads,controller,goalPending,voiceBusy]);
 const state=controller.state,run=state?Object.values(state.runs).find(active) as Run|undefined:undefined;
 const action=async(fn:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'操作未确认，请重试');}finally{setBusy(false);}};
 const send=()=>{if(voiceBusy)return;void action(async()=>{await controller.send(draft,uploads.references(),{goalMode:ordinary&&goalMode});uploads.clearSent();editDraft('');await controller.refresh();});};
 const uploadEntry=async(entryId:string)=>{await uploads.upload(entryId);await controller.refresh();};
 const selectFiles=(files:File[])=>{if(!state||busy||goalPending||controller.pendingMessage||uploads.unresolved||!maxBytes)return;void action(async()=>{const entries=files.map(file=>uploads.add(file,maxBytes));for(const entry of entries)await uploadEntry(entry.id);});};
 const select=(event:React.ChangeEvent<HTMLInputElement>)=>{const files=Array.from(event.target.files??[]);event.target.value='';selectFiles(files);};
 const changeModel=(model:ModelSelection)=>{if(!ordinary||!conversation||run||controller.pendingMessage||uploads.entries.length||voiceBusy||goalPending)return;void action(async()=>{const saved=await modelMutation.submit(`/conversations/${encodeURIComponent(id)}`,'PATCH',{expected_version:conversation.version,model}) as Conversation;setConversation(saved);await controller.refresh();});};
 const showPreview=(file:Artifact)=>void action(async()=>{const value=await request<Preview>(`/artifacts/${encodeURIComponent(file.artifact_id)}/preview?version=${file.version}`);if(value.artifact_id!==file.artifact_id||value.version!==file.version)throw new Error('文件预览未确认');if(value.kind==='text')setPreview({name:file.file_name,text:value.text??'',truncated:value.truncated});else if(value.kind==='image'){const response=await fetch(`${base}/v1/artifacts/${encodeURIComponent(file.artifact_id)}/download?version=${file.version}`,{credentials:'same-origin'});if(!response.ok)throw new Error('图片暂不可预览');const blob=await response.blob();if(!blob.type.startsWith('image/'))throw new Error('图片类型未确认');setPreview({name:file.file_name,url:URL.createObjectURL(blob)});}else setPreview({name:file.file_name,unsupported:true});});
 const download=(file:Artifact)=>void action(async()=>{const response=await fetch(`${base}/v1/artifacts/${encodeURIComponent(file.artifact_id)}/download?version=${file.version}`,{credentials:'same-origin'});if(!response.ok)throw new Error('文件暂不可下载');const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download=file.file_name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
 return <section className="workbench-conversation" aria-label={ordinary?"Ordinary conversation":"Role conversation"}><button disabled={busy||goalPending||controller.pendingMessage||uploads.entries.length>0||modelMutation.pending} onClick={onClose}>返回工作台</button><h2>{ordinary?'我的对话':'角色对话'}</h2><p role="status">{controller.connection==='connected'?'已连接':controller.connection==='reconnecting'?'正在重新连接':'正在连接'}{run?` · ${run.status}`:''}</p>{controller.error&&<p role="alert">{controller.error}</p>}
 {ordinary&&<ConversationGoal key={id} id={id} running={run?.status==='running'} runStatus={run?.status} controlRun={state?latestGoalRun(Object.values(state.runs),id):undefined} onResumeAccepted={()=>{void controller.refresh().catch(()=>{});}} onPendingChange={setGoalPending}/>}
 {state&&Object.values(state.messages).map((message:any)=>{const files=messageFiles(state,message) as Artifact[],open=expanded[message.message_id];return <article key={message.message_id} className={message.role}><small>{message.role==='user'?'YOU':'JOT'}</small>{message.status==='complete'&&onTaskSource&&<button disabled={busy||goalPending||controller.pendingMessage||uploads.entries.length>0} onClick={()=>onTaskSource({conversation_id:id,message})}>设为持续任务</button>}{message.blocks.filter((block:any)=>block.kind==='text').map((block:any)=><Markdown key={block.block_id} remarkPlugins={[remarkGfm]} skipHtml>{block.text}</Markdown>)}<div className={`jot-message-files ${message.role==='user'?'uploaded':''}`}>{(message.role==='user'||open?files:files.slice(0,3)).map(file=><button key={`${file.artifact_id}:${file.version}`} onClick={()=>message.role==='user'?showPreview(file):download(file)} disabled={busy}>{message.role==='user'?'预览':'下载'} {file.file_name}</button>)}</div>{message.role==='assistant'&&files.length>3&&<button onClick={()=>setExpanded(value=>({...value,[message.message_id]:!open}))}>{open?'收起':`展开其余 ${files.length-3} 个文件`}</button>}</article>;})}
 {state&&Object.values(state.interactions).filter((value:any)=>value.status==='pending').map((value:any)=><InteractionCard key={value.interaction_id} value={value} disabled={busy||controller.connection!=='connected'} submit={(body,key,signal)=>request(`/interactions/${encodeURIComponent(value.interaction_id)}/${value.kind==='approval'?'decision':'response'}`,'POST',body,key,signal)} onRefresh={()=>controller.refresh()}/>)}
 {error&&<p role="alert">{error}</p>}{controller.pendingMessage&&<p role="status">发送结果尚未确认；重试会保留原消息。</p>}
 {modelMutation.pending&&<p role="status">模型设置结果尚未确认。<button type="button" disabled={busy} onClick={()=>{if(conversation)changeModel(conversation.model);}}>重试原模型设置</button></p>}
 {preview&&<section role="region" aria-label="附件预览" className="jot-file-preview"><h3>{preview.name}</h3><button disabled={busy} onClick={()=>setPreview(undefined)}>关闭预览</button>{preview.url&&<img src={preview.url} alt={preview.name}/>} {preview.text!==undefined&&<pre>{preview.text}</pre>}{preview.truncated&&<p>预览内容已截短</p>}{preview.unsupported&&<p>此文件暂不支持在线预览</p>}</section>}
 <input ref={fileInput} type="file" aria-label="添加文件" multiple hidden disabled={!state||busy||goalPending||controller.pendingMessage||uploads.unresolved||!maxBytes} onChange={select}/>
 {ordinary&&goalMode&&<p role="status">目标模式</p>}
 <PromptComposer value={draft} onChange={editDraft} onSubmit={send} placeholder={ordinary&&goalMode?'描述你的目标…':'输入消息…'} ariaLabel={ordinary?'对话消息':'角色消息'}
  disabled={!state||busy||goalPending||modelMutation.pending} inputDisabled={controller.pendingMessage} submitDisabled={voiceBusy||uploads.entries.some((entry:any)=>entry.status!=='ready')||(ordinary&&goalMode&&!draft.trim()&&!controller.pendingMessage)} submitLabel={controller.pendingMessage?'重试原消息':run?'加入队列':'发送'}
  selection={conversation?.model} modelOptions={models} onSelectionChange={ordinary&&!run&&!controller.pendingMessage&&!uploads.entries.length&&!voiceBusy&&!goalPending&&!modelMutation.pending?changeModel:undefined}
  onAttach={()=>fileInput.current?.click()} attachDisabled={!state||busy||goalPending||controller.pendingMessage||uploads.unresolved||!maxBytes} onDropFiles={selectFiles}
  hasAttachments={uploads.entries.length>0} attachments={<>{uploads.entries.map((entry:any)=><div key={entry.id} className="jot-upload-entry"><span>{entry.file.name} · {entry.status==='ready'?'上传完成':entry.status==='uploading'?'正在上传':entry.status==='uncertain'?'结果尚未确认':entry.status==='rejected'?'上传被拒绝':'等待上传'}</span>{['uncertain','selected'].includes(entry.status)&&<button type="button" aria-label={`重试原附件 ${entry.file.name}`} disabled={busy||goalPending||controller.pendingMessage} onClick={()=>void action(()=>uploadEntry(entry.id))}>重试原附件</button>}{['selected','ready','rejected'].includes(entry.status)&&<button type="button" disabled={busy||goalPending||controller.pendingMessage} onClick={()=>uploads.remove(entry.id)}>移除 {entry.file.name}</button>}</div>)}<p role="status">待发送附件保留在当前页面；关闭或刷新页面会丢失待发送内容。</p></>}
  keepVoiceVisible voiceActive={voiceBusy} voiceControl={<VoiceInput id={id} voice={voice} disabled={!state||busy||goalPending||Boolean(controller.pendingMessage)||modelMutation.pending} onText={appendTranscript} onBusyChange={setVoiceBusy}/>}
  goalMenu={ordinary?<button type="button" role="menuitemcheckbox" aria-checked={goalMode} onClick={()=>setGoalMode(value=>!value)}>目标模式{goalMode?' ✓':''}</button>:undefined}
  responding={Boolean(run)} stopDisabled={run?.status==='cancelling'} onStop={run?()=>void action(async()=>{const latest=await request<Run>(`/runs/${encodeURIComponent(run.run_id)}`);if(active(latest)&&latest.status!=='cancelling')await request(`/runs/${encodeURIComponent(run.run_id)}/cancel`,'POST',{expected_run_version:latest.version});await controller.refresh();}):undefined}/>
 </section>;
}
