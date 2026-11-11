import {ApplicationLanguageProvider,applicationText,useApplicationText} from './jot/application-language';
import {prefersReducedMotion} from './jot/useInterfaceAppearance';
import {useThemePreference,ThemeSelector} from './jot/theme-preference';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import TwemojiMarkdown from './jot/TwemojiMarkdown';
import './style.css';
import {StandaloneCommand,standaloneCreation,standaloneModes,mergeStandaloneSnapshot} from './standalone-mode.mjs';
type Message={id:string;role:string;content:string;run_id?:string};
type Run={id:string;status:string;error?:string};
type Artifact={id:string;name:string;run_id?:string;size:number};
type Conversation={id:string;title:string;mode?:'chat'|'work';version?:number};
type Snapshot={conversation?:Conversation;messages:Message[];runs:Run[];artifacts:Artifact[];seq:number;approval?:any};
const initialSnapshot=():Snapshot=>({messages:[],runs:[],artifacts:[],seq:0});
const active=(r:Run)=>['queued','running','waiting_approval'].includes(r.status);
const readable=(value:string)=>({thinking:'Thinking',queued:'Starting',running:'Working',waiting_approval:'Waiting for your approval',succeeded:'Completed',failed:'Task failed',cancelled:'Cancelled',interrupted:'Interrupted',search:'Searching',read_page:'Reading a page',write_file:'Preparing a file',browser_execute:'Using the browser'}[value]||value.replaceAll('_',' '));
const statusTranslations:Record<string,string>={'Ready':'就绪','Thinking':'思考中','Starting':'正在启动','Working':'工作中','Waiting for your approval':'等待你的审批','Completed':'已完成','Task failed':'任务失败','Cancelled':'已取消','Interrupted':'已中断','Searching':'搜索中','Reading a page':'阅读页面中','Preparing a file':'准备文件中','Using the browser':'使用浏览器中','Reconnecting':'重新连接中','Cancelling':'取消中'};
const promptExamples=[['帮我整理一个简短计划','Help me organize a short plan'],['创建 Markdown 任务清单','Create a Markdown task checklist'],['总结已上传的文本文件','Summarize an uploaded text file']] as const;
function SampleSurface(){
  const text=useApplicationText(),sampleLabels:Record<string,string>={research:text('研究','research'),approval:text('审批','approval'),delivery:text('交付','delivery')};
  const [sample,setSample]=useState('research'),[decision,setDecision]=useState('');
  return <section className="sample-surface" aria-label={text('示例界面','Sample interface')}><div className="sample-heading"><strong>{text('界面示例','Interface samples')}</strong><small>{text('仅用于展示 · 不运行任务','Illustrative only · no task runs')}</small></div><div className="sample-tabs" role="group" aria-label={text('选择示例','Choose a sample')}>{['research','approval','delivery'].map(x=><button key={x} aria-pressed={sample===x} onClick={()=>{setSample(x);setDecision('');}}>{sampleLabels[x]}</button>)}</div>
    {sample==='research'&&<div><p>{text('搜索与阅读进度','Search and reading progress')}</p><div className="chips">{[[text('远程办公','remote work'),'remote-work'],[text('规划','planning'),'planning'],[text('写作','writing'),'writing'],['+12','more']].map(([label,id])=><span key={id}>{label}</span>)}</div><details className="trace"><summary>{text('查看示例步骤','View sample steps')}</summary><p>{text('比较结果、核对来源，再整理简短摘要。','Compare the results, check the sources, then prepare a short summary.')}</p><code lang="en">search → read_page → answer</code></details></div>}
    {sample==='approval'&&<div><p>{text('在执行前审核浏览器操作。','Review a browser action before it happens.')}</p><code lang="en">click · target: “Next page”</code><div className="sample-actions"><button onClick={()=>setDecision('approved')}>{text('同意示例','Approve sample')}</button><button onClick={()=>setDecision('declined')}>{text('拒绝示例','Decline sample')}</button></div>{decision&&<p role="status">{decision==='approved'?text('已同意示例，没有执行浏览器操作。','Sample approved. No browser action was executed.'):text('已拒绝示例，没有执行浏览器操作。','Sample declined. No browser action was executed.')}</p>}</div>}
    {sample==='delivery'&&<div><p>{text('已完成的答复可以包含该任务生成的文件。','Completed answers can include files from that exact task.')}</p><div className="file sample-file"><strong>↧ task-checklist.md</strong><small>{text('示例文件','Sample file')}</small></div><p className="sample-note">{text('这是布局预览。运行 Agent 任务后，才会生成可下载的实际文件。','This is a layout preview. Run an Agent task to create a real downloadable file.')}</p></div>}
  </section>;
}
function App(){
  const appearance=useThemePreference(),text=applicationText(appearance.language);
  useEffect(()=>{const previous=document.title,title=appearance.language==='zh-CN'?'Jot · 轻量 AI 助手':'Jot · lightweight AI bot';document.title=title;return()=>{if(document.title===title)document.title=previous;};},[appearance.language]);
  const [caps,setCaps]=useState<any>(),[chats,setChats]=useState<any[]>([]),[selected,setSelected]=useState('');
  const [snapshot,setSnapshot]=useState<Snapshot>({messages:[],runs:[],artifacts:[],seq:0}),[draft,setDraft]=useState(''),[stream,setStream]=useState(''),[status,setStatus]=useState('Ready'),[details,setDetails]=useState<any[]>([]),[approval,setApproval]=useState<any>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [deciding,setDeciding]=useState(false),[cancelling,setCancelling]=useState(false),[uploading,setUploading]=useState(false),[commandBusy,setCommandBusy]=useState(false),[,tickCommand]=useState(0);
  const csrf=useRef(''),bottom=useRef<HTMLDivElement>(null),selectedRef=useRef(''),draftRef=useRef(''),requests=useRef<Record<string,string>>({}),drafts=useRef<Record<string,string>>({}),sending=useRef(new Set<string>());
  const api=async(path:string,method='GET',body?:unknown,signal?:AbortSignal)=>{const r=await fetch('/api'+path,{method,signal,headers:{'x-jot-token':csrf.current,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const value=await r.json();if(!r.ok)throw Object.assign(new Error(value.error||'Request failed'),{status:r.status});return value;};
  const command=useMemo(()=>new StandaloneCommand((p:string,m:string,b:unknown)=>api(p,m,b),()=>tickCommand(n=>n+1)),[]);
  const settingsPending=commandBusy||command.pending;
  const refresh=async(id:string)=>{const s=await api(`/conversations/${id}/snapshot`);if(selectedRef.current===id)setSnapshot(v=>mergeStandaloneSnapshot(v,s));return s;};
  const reloadChats=async()=>{const list=await api('/conversations');setChats(list);return list;};
  const select=(id:string)=>{if(command.pending||commandBusy||uploading||selectedRef.current===id)return;drafts.current[selectedRef.current]=draftRef.current;selectedRef.current=id;draftRef.current=drafts.current[id]||'';setDraft(draftRef.current);setSelected(id);setSnapshot(initialSnapshot());setStream('');setDetails([]);setApproval(undefined);setStatus('Ready');setError('');setBusy(sending.current.has(id));setDeciding(false);setCancelling(false);};
  const changeDraft=(text:string)=>{if(command.pending||commandBusy)return;draftRef.current=text;drafts.current[selectedRef.current]=text;setDraft(text);delete requests.current[selectedRef.current];};
  const applySetting=async(c:Conversation)=>{if(selectedRef.current===c.id)setSnapshot(v=>mergeStandaloneSnapshot(v,{...v,conversation:c}));await reloadChats();await refresh(c.id);};
  const setting=async(path?:string,method?:string,body?:unknown)=>{
    if(commandBusy)return;setCommandBusy(true);setError('');
    const originalMethod=method??command.command?.method;
    try{
      const result:Conversation=await(path?command.send(path,method,body):command.retry());
      if(originalMethod==='POST'){
        await reloadChats();drafts.current[selectedRef.current]=draftRef.current;selectedRef.current=result.id;
        draftRef.current=drafts.current[result.id]||'';setDraft(draftRef.current);setSelected(result.id);
        setSnapshot(initialSnapshot());setStream('');setDetails([]);setApproval(undefined);setStatus('Ready');setBusy(false);
      }else await applySetting(result);
    }catch(e){setError(String(e));if(!command.pending&&selectedRef.current)await refresh(selectedRef.current).catch(()=>{});}
    finally{setCommandBusy(false);}
  };
  const create=async(capabilities=caps)=>{if(settingsPending||uploading)return;try{await setting('/conversations','POST',standaloneCreation(capabilities));}catch(e){setError(String(e));}};
  useEffect(()=>{if(!command.pending)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[settingsPending]);
  useEffect(()=>{let disposed=false;fetch('/api/capabilities').then(r=>{if(!r.ok)throw new Error('Cannot connect to Jot');return r.json();}).then(async c=>{if(disposed)return;standaloneModes(c);csrf.current=c.csrf;setCaps(c);const list=await reloadChats();if(!disposed){if(list.length)select(list[0].id);else await create(c);}}).catch(e=>{if(!disposed)setError(String(e));});return()=>{disposed=true;};},[]);
  useEffect(()=>{
    if(!selected)return;const controller=new AbortController();const current=()=>!controller.signal.aborted&&selectedRef.current===selected;
    setStream('');setDetails([]);setApproval(undefined);setStatus('Ready');setError('');
    const follow=async()=>{
      while(current()){
        try {
          const s:Snapshot=await api(`/conversations/${selected}/snapshot`,'GET',undefined,controller.signal);if(!current())return;setSnapshot(v=>mergeStandaloneSnapshot(v,s));let cursor=0,latestId=s.runs.at(-1)?.id,liveId=s.runs.find(active)?.id;
          setApproval(s.approval??undefined);setStream('');setDetails([]);setCancelling(false);setStatus(s.runs.length?readable(s.runs.at(-1)!.status):'Ready');
          // Replay current-run events so a reconnect restores progress and draft text.
          const response=await fetch(`/api/conversations/${selected}/events?after=0`,{headers:{'x-jot-token':csrf.current},signal:controller.signal});if(!response.ok||!response.body)throw new Error('Connection failed');
          const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
          while(current()){const part=await reader.read();if(part.done)throw new Error('Reconnecting');buffer+=decoder.decode(part.value,{stream:true});let end;
            while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(!data)continue;const event=JSON.parse(data);if(event.seq<=cursor)continue;cursor=event.seq;if(!current())return;const fresh=event.seq>s.seq;
              if(event.type==='run.state'&&fresh){const run:Run=event.data.run;latestId=run.id;liveId=active(run)?run.id:undefined;setSnapshot(v=>({...v,seq:Math.max(v.seq,event.seq),runs:v.runs.some(r=>r.id===run.id)?v.runs.map(r=>r.id===run.id?run:r):[...v.runs,run]}));setStatus(readable(run.status));if(run.status==='queued'){setStream('');setDetails([]);}if(!active(run)){setStream('');setApproval(undefined);setCancelling(false);void refresh(selected).catch(e=>{if(current())setError(String(e));});}}
              if(event.data.run_id!==latestId)continue;
              if(event.type==='assistant.delta'&&event.data.run_id===liveId)setStream(v=>v+event.data.text);
              if(event.type==='activity'){setStream('');setStatus(readable(event.data.phase||event.data.label));setDetails(v=>[...v.slice(-49),event.data]);}
              if(event.type==='approval.request'&&(fresh||event.data.run_id===liveId))setApproval(event.data);
              if(event.type==='approval.resolved')setApproval(undefined);
              if(event.type==='assistant.complete'&&fresh){setStream('');if(event.data.message)setSnapshot(v=>({...v,seq:Math.max(v.seq,event.seq),messages:v.messages.some(m=>m.id===event.data.message.id)?v.messages:[...v.messages,event.data.message]}));}
            }
          }
        }catch(e){if(!current())return;setStatus('Reconnecting');await new Promise(r=>setTimeout(r,1500));}
      }
    };void follow();return()=>controller.abort();
  },[selected]);
  useEffect(()=>{bottom.current?.scrollIntoView({behavior:prefersReducedMotion()?'auto':'smooth'});},[snapshot.messages.length,stream,approval]);
  const statusText=(value:string)=>appearance.language==='zh-CN'?(statusTranslations[value]??value):value;
  const localErrors:Record<string,string>={'Error: Cannot connect to Jot':text('无法连接 Jot。','Cannot connect to Jot.'),'Error: Request failed':text('请求失败。','Request failed.'),'Error: File expired':text('文件已过期。','File expired.'),'Error: Download failed':text('下载失败。','Download failed.'),'Error: Choose a file under 1 MB.':text('请选择小于 1 MB 的文件。','Choose a file under 1 MB.')};
  const running=snapshot.runs.find(active);
  const modes=standaloneModes(caps),mode=snapshot.conversation?.mode??'work',unavailable=mode==='chat'&&!modes.chatReady;
  const switchMode=()=>{if(settingsPending||running||busy||uploading||requests.current[selected]||!modes.aware||!snapshot.conversation?.version||mode==='work'&&!modes.chatReady)return;void setting('/conversations/'+encodeURIComponent(selected),'PATCH',{mode:mode==='chat'?'work':'chat',expected_version:snapshot.conversation.version});};
  const send=async(e:React.FormEvent)=>{e.preventDefault();const id=selectedRef.current,text=draftRef.current;if(settingsPending||uploading||unavailable||!id||!text.trim()||sending.current.has(id)||running)return;sending.current.add(id);setBusy(true);setError('');
    try{requests.current[id]||=crypto.randomUUID();await api(`/conversations/${id}/messages`,'POST',{text,request_id:requests.current[id]});delete requests.current[id];if(drafts.current[id]===text)drafts.current[id]='';if(selectedRef.current===id&&draftRef.current===text){draftRef.current='';setDraft('');}await refresh(id);}catch(e){if(selectedRef.current===id)setError(String(e));}finally{sending.current.delete(id);if(selectedRef.current===id)setBusy(false);}};
  const decide=async(allowed:boolean)=>{const item=approval,id=selectedRef.current;if(!item||deciding)return;setDeciding(true);try{await api(`/runs/${item.run_id}/approval`,'POST',{approval_id:item.approval_id,allowed});if(selectedRef.current===id)setApproval(undefined);}catch(e){if(selectedRef.current===id)setError(String(e));}finally{if(selectedRef.current===id)setDeciding(false);}};
  const cancel=async()=>{const run=running,id=selectedRef.current;if(!run||cancelling)return;setCancelling(true);setStatus('Cancelling');try{await api(`/runs/${run.id}/cancel`,'POST',{});await refresh(id);}catch(e){if(selectedRef.current===id){setError(String(e));setCancelling(false);}}};
  const download=async(a:Artifact)=>{const id=selectedRef.current;try{const r=await fetch(`/api/artifacts/${a.id}/download`,{headers:{'x-jot-token':csrf.current}});if(!r.ok)throw new Error(r.status===410?'File expired':'Download failed');const url=URL.createObjectURL(await r.blob()),link=document.createElement('a');link.href=url;link.download=a.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){if(selectedRef.current===id)setError(String(e));}};
  const upload=async(file?:File)=>{if(!file||settingsPending||uploading||!selected)return;const id=selectedRef.current;setUploading(true);try{if(file.size>(caps?.limits?.max_file_bytes??1000000))throw new Error('Choose a file under 1 MB.');const a=await api(`/conversations/${id}/files`,'POST',{name:file.name,text:await file.text()});const next=`${drafts.current[id]||''}\nAttached file: ${a.name} (artifact_id: ${a.id})`;drafts.current[id]=next;if(selectedRef.current===id){draftRef.current=next;setDraft(next);}await refresh(id);}catch(e){if(selectedRef.current===id)setError(String(e));}finally{setUploading(false);}};
  return <ApplicationLanguageProvider value={appearance.language}><div className="app" lang={appearance.language}><aside><a className="brand" href="/">jot<span>AI BOT</span></a><button className="new" aria-label={text('新建对话','Create a new chat')} disabled={!caps||settingsPending||uploading} onClick={()=>void create()}>{text('＋ 新建对话','＋ New chat')}</button><nav className="chats" aria-label={text('对话','Conversations')}>{chats.map(c=><button className={c.id===selected?'selected':''} aria-current={c.id===selected?'page':undefined} key={c.id} title={c.title} disabled={settingsPending||uploading} onClick={()=>select(c.id)}>{c.title}</button>)}</nav><small>{text('本地工作区','Local workspace')}</small></aside><main><header><div><strong>Jot</strong><a href="/workbench.html" lang={appearance.language}>{appearance.language==='zh-CN'?'工作台':'Workbench'}</a><button className="standalone-mode" aria-label={text(`切换到 ${mode==='chat'?'work':'chat'}`,`Switch to ${mode==='chat'?'work':'chat'}`)} disabled={!selected||!snapshot.conversation?.version||!modes.aware||settingsPending||!!running||busy||uploading||!!requests.current[selected]||mode==='work'&&!modes.chatReady} onClick={switchMode}>{mode}</button><span>{text('更轻巧，更实用。','A little lighter. A lot more useful.')}</span></div><ThemeSelector preference={appearance}/></header>
    {caps?.mode==='demo'&&<div className="notice">{text('演示 · 使用合成答复，不连接模型或外部网站。','DEMO · Synthetic responses. No model or external site is contacted.')}</div>}
    {caps?.mode==='agent'&&!caps.model_configured&&<div className="notice">{text('请在 .env 中配置模型，以运行实际 Agent 任务。','Configure a model in .env to start real Agent tasks.')}</div>}
    {unavailable&&<div className="notice">{text('Chat 暂不可用。请切换到 Work，或配置 Chat 路由。','Chat is unavailable. Switch to Work or configure the Chat route.')}</div>}{command.pending&&<div className="notice" role="status">{text('对话设置尚未确认，请保留此页面。','Conversation setting is unconfirmed. Keep this page open.')}<button disabled={commandBusy} onClick={()=>void setting()}>{text('重试原设置','Retry original setting')}</button></div>}
    <section className="timeline" aria-label={text('对话消息','Chat messages')}>{!snapshot.messages.length&&<div className="welcome"><div className="orb"/><h1>{text('小巧的助手。','Small bot.')}<br/>{text('实用的工作。','Useful work.')}</h1><p>{text('问个问题，带上一份文件，','Ask a question, bring a file,')}<br/>{text('或者让 Jot 接着做。','or let Jot take the next step.')}</p><div className="examples">{promptExamples.map(([zh,en])=><button key={en} onClick={()=>changeDraft(text(zh,en))}>{text(zh,en)} ↗</button>)}</div>{caps?.mode==='demo'&&<SampleSurface/>}</div>}
      {snapshot.messages.map(m=><article key={m.id} className={m.role}><small>{m.role==='user'?text('你','YOU'):'JOT'}</small><TwemojiMarkdown>{m.content}</TwemojiMarkdown>{m.role==='assistant'&&snapshot.artifacts.filter(a=>a.run_id&&snapshot.runs.find(r=>r.id===a.run_id)?.status==='succeeded').filter(a=>a.run_id===m.run_id).map(a=><button key={a.id} className="file" onClick={()=>void download(a)}>↧ {a.name}<span>{Math.ceil(a.size/1024)} KB</span></button>)}</article>)}
      {stream&&<article className="assistant draft-response"><small>{text('JOT · 正在生成答复','JOT · DRAFT IN PROGRESS')}</small><TwemojiMarkdown>{stream}</TwemojiMarkdown></article>}
      {approval&&<div className="approval"><strong>{text('审核此操作','Review this action')}</strong><p>{approval.description}</p>{approval.operation!==undefined&&<pre>{JSON.stringify(approval.operation,null,2)}</pre>}<button disabled={deciding||cancelling} onClick={()=>void decide(true)}>{text('同意','Approve')}</button><button disabled={deciding||cancelling} onClick={()=>void decide(false)}>{text('拒绝','Decline')}</button></div>}
      {details.length>0&&<details className="trace"><summary>{text(`任务详情 · ${details.length} 步`,`Task details · ${details.length} steps`)}</summary>{details.map((x,i)=><p key={i}>{statusText(readable(x.phase||x.label))}<code>{JSON.stringify(x.args??{})}</code></p>)}</details>}
      {snapshot.runs.at(-1)?.status==='failed'&&<p className="error" role="alert">{text('任务失败：','Task failed: ')}{snapshot.runs.at(-1)?.error||text('请重试。','Please try again.')}</p>}
      {snapshot.runs.at(-1)?.status==='interrupted'&&<p className="notice">{text('服务器在任务期间重新启动。发送新消息以继续。','The server restarted during this task. Send a new message to continue.')}</p>}
      {snapshot.artifacts.some(a=>!a.run_id)&&<div className="uploads"><small>{text('此对话中已上传的文件','UPLOADED FILES IN THIS CHAT')}</small><div className="chips">{snapshot.artifacts.filter(a=>!a.run_id).map(a=><button key={a.id} onClick={()=>void download(a)} title={a.name}>▤ {a.name}</button>)}</div></div>}
      {error&&<p role="alert" className="error">{localErrors[error]??error}</p>}<div ref={bottom}/>
    </section><footer><div className="state" role="status"><i className={running?'pulse':''}/>{statusText(cancelling?'Cancelling':running?status:snapshot.runs.length?readable(snapshot.runs.at(-1)!.status):'Ready')}</div><form onSubmit={send}><label className="attach" title={text('上传文本、Markdown、JSON 或 CSV','Upload text, Markdown, JSON or CSV')}>＋<input aria-label={text('上传文本文件','Upload a text file')} disabled={!selected||settingsPending||uploading} type="file" accept=".txt,.md,.json,.csv" onChange={e=>{void upload(e.target.files?.[0]);e.target.value='';}}/></label><textarea disabled={settingsPending} aria-label={text('消息','Message')} placeholder={running?text('起草下一条消息…','Draft your next message…'):text('有什么可以帮你？','What can I help with?')} value={draft} maxLength={caps?.limits?.max_message_chars??8000} onChange={e=>changeDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send(e);}}}/>{running?<button type="button" aria-label={text('取消任务','Cancel task')} disabled={cancelling} onClick={()=>void cancel()}>■</button>:<button type="submit" aria-label={text('发送消息','Send message')} disabled={busy||settingsPending||uploading||unavailable||!selected||!draft.trim()}>↑</button>}</form><small>{caps?.mode==='demo'?text('可操作的界面，示例输出均有明确标记。','A working interface, with clearly labelled sample output.'):text('请审核重要操作并核对结果。','Review important actions and verify results.')}</small></footer>
  </main></div></ApplicationLanguageProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
