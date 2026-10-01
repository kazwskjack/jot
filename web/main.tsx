import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './style.css';
type Message={id:string;role:string;content:string;run_id?:string};
type Run={id:string;status:string;error?:string};
type Artifact={id:string;name:string;run_id?:string;size:number};
type Snapshot={messages:Message[];runs:Run[];artifacts:Artifact[];seq:number;approval?:any};
const initialSnapshot=():Snapshot=>({messages:[],runs:[],artifacts:[],seq:0});
const active=(r:Run)=>['queued','running','waiting_approval'].includes(r.status);
const readable=(value:string)=>({thinking:'Thinking',queued:'Starting',running:'Working',waiting_approval:'Waiting for your approval',succeeded:'Completed',failed:'Task failed',cancelled:'Cancelled',interrupted:'Interrupted',search:'Searching',read_page:'Reading a page',write_file:'Preparing a file',browser_execute:'Using the browser'}[value]||value.replaceAll('_',' '));
function SampleSurface(){
  const [sample,setSample]=useState('research'),[decision,setDecision]=useState('');
  return <section className="sample-surface" aria-label="Sample interface"><div className="sample-heading"><strong>Interface samples</strong><small>Illustrative only · no task runs</small></div><div className="sample-tabs" role="group" aria-label="Choose a sample">{['research','approval','delivery'].map(x=><button key={x} aria-pressed={sample===x} onClick={()=>{setSample(x);setDecision('');}}>{x}</button>)}</div>
    {sample==='research'&&<div><p>Search and reading progress</p><div className="chips">{['remote work','planning','writing','+12'].map(x=><span key={x}>{x}</span>)}</div><details className="trace"><summary>View sample steps</summary><p>Compare the results, check the sources, then prepare a short summary.</p><code>search → read_page → answer</code></details></div>}
    {sample==='approval'&&<div><p>Review a browser action before it happens.</p><code>click · target: “Next page”</code><div className="sample-actions"><button onClick={()=>setDecision('Sample approved. No browser action was executed.')}>Approve sample</button><button onClick={()=>setDecision('Sample declined. No browser action was executed.')}>Decline sample</button></div>{decision&&<p role="status">{decision}</p>}</div>}
    {sample==='delivery'&&<div><p>Completed answers can include files from that exact task.</p><div className="file sample-file"><strong>↧ task-checklist.md</strong><small>Sample file</small></div><p className="sample-note">This is a layout preview. Run an Agent task to create a real downloadable file.</p></div>}
  </section>;
}
function App(){
  const [theme,setTheme]=useState(()=>localStorage.getItem('jot-theme')==='light'?'light':'dark');
  const [caps,setCaps]=useState<any>(),[chats,setChats]=useState<any[]>([]),[selected,setSelected]=useState('');
  const [snapshot,setSnapshot]=useState<Snapshot>({messages:[],runs:[],artifacts:[],seq:0}),[draft,setDraft]=useState(''),[stream,setStream]=useState(''),[status,setStatus]=useState('Ready'),[details,setDetails]=useState<any[]>([]),[approval,setApproval]=useState<any>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [deciding,setDeciding]=useState(false),[cancelling,setCancelling]=useState(false);
  const csrf=useRef(''),bottom=useRef<HTMLDivElement>(null),selectedRef=useRef(''),draftRef=useRef(''),requests=useRef<Record<string,string>>({}),drafts=useRef<Record<string,string>>({}),sending=useRef(new Set<string>());
  const api=async(path:string,method='GET',body?:unknown,signal?:AbortSignal)=>{const r=await fetch('/api'+path,{method,signal,headers:{'x-jot-token':csrf.current,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const value=await r.json();if(!r.ok)throw new Error(value.error||'Request failed');return value;};
  const refresh=async(id:string)=>{const s=await api(`/conversations/${id}/snapshot`);if(selectedRef.current===id)setSnapshot(v=>s.seq>=v.seq?s:v);return s;};
  const reloadChats=async()=>{const list=await api('/conversations');setChats(list);return list;};
  const select=(id:string)=>{if(selectedRef.current===id)return;drafts.current[selectedRef.current]=draftRef.current;selectedRef.current=id;draftRef.current=drafts.current[id]||'';setDraft(draftRef.current);setSelected(id);setSnapshot(initialSnapshot());setStream('');setDetails([]);setApproval(undefined);setStatus('Ready');setError('');setBusy(sending.current.has(id));setDeciding(false);setCancelling(false);};
  const changeDraft=(text:string)=>{draftRef.current=text;drafts.current[selectedRef.current]=text;setDraft(text);delete requests.current[selectedRef.current];};
  const create=async()=>{try{const c=await api('/conversations','POST',{title:'New chat'});await reloadChats();select(c.id);}catch(e){setError(String(e));}};
  useEffect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem('jot-theme',theme);document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#101217':'#faf9f6');},[theme]);
  useEffect(()=>{let disposed=false;fetch('/api/capabilities').then(r=>{if(!r.ok)throw new Error('Cannot connect to Jot');return r.json();}).then(async c=>{if(disposed)return;csrf.current=c.csrf;setCaps(c);const list=await reloadChats();if(!disposed){if(list.length)select(list[0].id);else await create();}}).catch(e=>{if(!disposed)setError(String(e));});return()=>{disposed=true;};},[]);
  useEffect(()=>{
    if(!selected)return;const controller=new AbortController();const current=()=>!controller.signal.aborted&&selectedRef.current===selected;
    setStream('');setDetails([]);setApproval(undefined);setStatus('Ready');setError('');
    const follow=async()=>{
      while(current()){
        try {
          const s:Snapshot=await api(`/conversations/${selected}/snapshot`,'GET',undefined,controller.signal);if(!current())return;setSnapshot(s);let cursor=0,latestId=s.runs.at(-1)?.id,liveId=s.runs.find(active)?.id;
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
  useEffect(()=>bottom.current?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}),[snapshot.messages.length,stream,approval]);
  const running=snapshot.runs.find(active);
  const send=async(e:React.FormEvent)=>{e.preventDefault();const id=selectedRef.current,text=draftRef.current;if(!id||!text.trim()||sending.current.has(id)||running)return;sending.current.add(id);setBusy(true);setError('');
    try{requests.current[id]||=crypto.randomUUID();await api(`/conversations/${id}/messages`,'POST',{text,request_id:requests.current[id]});delete requests.current[id];if(drafts.current[id]===text)drafts.current[id]='';if(selectedRef.current===id&&draftRef.current===text){draftRef.current='';setDraft('');}await refresh(id);}catch(e){if(selectedRef.current===id)setError(String(e));}finally{sending.current.delete(id);if(selectedRef.current===id)setBusy(false);}};
  const decide=async(allowed:boolean)=>{const item=approval,id=selectedRef.current;if(!item||deciding)return;setDeciding(true);try{await api(`/runs/${item.run_id}/approval`,'POST',{approval_id:item.approval_id,allowed});if(selectedRef.current===id)setApproval(undefined);}catch(e){if(selectedRef.current===id)setError(String(e));}finally{if(selectedRef.current===id)setDeciding(false);}};
  const cancel=async()=>{const run=running,id=selectedRef.current;if(!run||cancelling)return;setCancelling(true);setStatus('Cancelling');try{await api(`/runs/${run.id}/cancel`,'POST',{});await refresh(id);}catch(e){if(selectedRef.current===id){setError(String(e));setCancelling(false);}}};
  const download=async(a:Artifact)=>{const id=selectedRef.current;try{const r=await fetch(`/api/artifacts/${a.id}/download`,{headers:{'x-jot-token':csrf.current}});if(!r.ok)throw new Error(r.status===410?'File expired':'Download failed');const url=URL.createObjectURL(await r.blob()),link=document.createElement('a');link.href=url;link.download=a.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){if(selectedRef.current===id)setError(String(e));}};
  const upload=async(file?:File)=>{if(!file)return;const id=selectedRef.current;try{if(file.size>(caps?.limits?.max_file_bytes??1000000))throw new Error('Choose a file under 1 MB.');const a=await api(`/conversations/${id}/files`,'POST',{name:file.name,text:await file.text()});const next=`${drafts.current[id]||''}\nAttached file: ${a.name} (artifact_id: ${a.id})`;drafts.current[id]=next;if(selectedRef.current===id){draftRef.current=next;setDraft(next);}await refresh(id);}catch(e){if(selectedRef.current===id)setError(String(e));}};
  return <div className="app"><aside><a className="brand" href="/">jot<span>AI BOT</span></a><button className="new" aria-label="Create a new chat" disabled={!caps} onClick={()=>void create()}>＋ New chat</button><nav className="chats" aria-label="Conversations">{chats.map(c=><button className={c.id===selected?'selected':''} aria-current={c.id===selected?'page':undefined} key={c.id} title={c.title} onClick={()=>select(c.id)}>{c.title}</button>)}</nav><small>Local workspace</small></aside><main><header><div><strong>Jot</strong><span>A little lighter. A lot more useful.</span></div><button onClick={()=>setTheme(theme==='dark'?'light':'dark')} aria-label={theme==='dark'?'Use light theme':'Use dark theme'}>{theme==='dark'?'☀':'☾'}</button></header>
    {caps?.mode==='demo'&&<div className="notice">DEMO · Synthetic responses. No model or external site is contacted.</div>}
    {caps?.mode==='agent'&&!caps.model_configured&&<div className="notice">Configure a model in .env to start real Agent tasks.</div>}
    <section className="timeline" aria-label="Chat messages">{!snapshot.messages.length&&<div className="welcome"><div className="orb"/><h1>Small bot.<br/>Useful work.</h1><p>Ask a question, bring a file,<br/>or let Jot take the next step.</p><div className="examples">{['Help me organize a short plan','Create a Markdown task checklist','Summarize an uploaded text file'].map(x=><button key={x} onClick={()=>changeDraft(x)}>{x} ↗</button>)}</div>{caps?.mode==='demo'&&<SampleSurface/>}</div>}
      {snapshot.messages.map(m=><article key={m.id} className={m.role}><small>{m.role==='user'?'YOU':'JOT'}</small><Markdown remarkPlugins={[remarkGfm]} skipHtml>{m.content}</Markdown>{m.role==='assistant'&&snapshot.artifacts.filter(a=>a.run_id&&snapshot.runs.find(r=>r.id===a.run_id)?.status==='succeeded').filter(a=>a.run_id===m.run_id).map(a=><button key={a.id} className="file" onClick={()=>void download(a)}>↧ {a.name}<span>{Math.ceil(a.size/1024)} KB</span></button>)}</article>)}
      {stream&&<article className="assistant draft-response"><small>JOT · DRAFT IN PROGRESS</small><Markdown remarkPlugins={[remarkGfm]} skipHtml>{stream}</Markdown></article>}
      {approval&&<div className="approval"><strong>Review this action</strong><p>{approval.description}</p>{approval.operation!==undefined&&<pre>{JSON.stringify(approval.operation,null,2)}</pre>}<button disabled={deciding||cancelling} onClick={()=>void decide(true)}>Approve</button><button disabled={deciding||cancelling} onClick={()=>void decide(false)}>Decline</button></div>}
      {details.length>0&&<details className="trace"><summary>Task details · {details.length} steps</summary>{details.map((x,i)=><p key={i}>{readable(x.phase||x.label)}<code>{JSON.stringify(x.args??{})}</code></p>)}</details>}
      {snapshot.runs.at(-1)?.status==='failed'&&<p className="error" role="alert">Task failed: {snapshot.runs.at(-1)?.error||'Please try again.'}</p>}
      {snapshot.runs.at(-1)?.status==='interrupted'&&<p className="notice">The server restarted during this task. Send a new message to continue.</p>}
      {snapshot.artifacts.some(a=>!a.run_id)&&<div className="uploads"><small>UPLOADED FILES IN THIS CHAT</small><div className="chips">{snapshot.artifacts.filter(a=>!a.run_id).map(a=><button key={a.id} onClick={()=>void download(a)} title={a.name}>▤ {a.name}</button>)}</div></div>}
      {error&&<p role="alert" className="error">{error}</p>}<div ref={bottom}/>
    </section><footer><div className="state" role="status"><i className={running?'pulse':''}/>{cancelling?'Cancelling':running?status:snapshot.runs.length?readable(snapshot.runs.at(-1)!.status):'Ready'}</div><form onSubmit={send}><label className="attach" title="Upload text, Markdown, JSON or CSV">＋<input aria-label="Upload a text file" disabled={!selected} type="file" accept=".txt,.md,.json,.csv" onChange={e=>{void upload(e.target.files?.[0]);e.target.value='';}}/></label><textarea aria-label="Message" placeholder={running?'Draft your next message…':'What can I help with?'} value={draft} maxLength={caps?.limits?.max_message_chars??8000} onChange={e=>changeDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send(e);}}}/>{running?<button type="button" aria-label="Cancel task" disabled={cancelling} onClick={()=>void cancel()}>■</button>:<button type="submit" aria-label="Send message" disabled={busy||!selected||!draft.trim()}>↑</button>}</form><small>{caps?.mode==='demo'?'A working interface, with clearly labelled sample output.':'Review important actions and verify results.'}</small></footer>
  </main></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
