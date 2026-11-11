import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import React,{lazy,Suspense,useEffect,useState} from 'react';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import {ApiError,request,taskDraftScope} from './client';
import {nativeMemberDownloadUrl,type NativeMemberPreviewSource} from './activity-file-preview-client';
import type {ActivityNativeFileOpeningsPage} from './types';

type Target={runId:string;activityId:string;toolName:'glob'|'grep';asOfSeq?:string};
type Opening=ActivityNativeFileOpeningsPage['items'][number];
const NativeSearchFile=lazy(()=>import('./NativeSearchFile'));
const sha=(value:unknown):value is string=>typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/.test(value);
const exact=(value:object,required:string[],optional:string[]=[])=>required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const seq=(value:unknown)=>typeof value==='string'&&value.length<=19&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&String(BigInt(value))===value&&BigInt(value)<=9223372036854775807n;

export default function NativeFileOpenings({conversationId,target}:{conversationId:string;target:Target}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,target]);
 const [cursor,setCursor]=useState<{identity:string;offset:number;previous:number[];sha?:string}>({identity,offset:0,previous:[]});
 const [state,setState]=useState<{identity:string;offset:number;page?:ActivityNativeFileOpeningsPage;error?:string}>(),[revision,setRevision]=useState(0);
 const [selected,setSelected]=useState<{identity:string;item:Opening}>();
 const currentCursor=cursor.identity===identity?cursor:{identity,offset:0,previous:[],sha:undefined};
 const {offset,sha:expected}=currentCursor;
 useEffect(()=>{
  const controller=new AbortController();setState({identity,offset});
  const load=async()=>{
   const query=new URLSearchParams({run_id:target.runId,offset_openings:String(offset),...(target.asOfSeq!==undefined?{as_of_seq:target.asOfSeq}:{}),...(expected?{openings_sha256:expected}:{})});
   const page=await request<ActivityNativeFileOpeningsPage>(`/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(target.activityId)}/tool-result/openings?${query}`,'GET',undefined,undefined,controller.signal);
   if(taskDraftScope()!==owner||!page||!exact(page,['conversation_id','run_id','activity_id','tool_name','scope','openings_sha256','offset_openings','total_openings','items','execution_authorized'],['as_of_seq','next_offset_openings'])
    ||page.conversation_id!==conversationId||page.run_id!==target.runId||page.activity_id!==target.activityId||page.tool_name!==target.toolName
    ||page.scope!=='owned_opened_files'||page.execution_authorized!==false||page.as_of_seq!==target.asOfSeq||!sha(page.openings_sha256)||expected!==undefined&&page.openings_sha256!==expected
    ||page.offset_openings!==offset||!Number.isSafeInteger(page.total_openings)||page.total_openings<offset||page.total_openings>128
    ||!Array.isArray(page.items)||page.items.length!==Math.min(8,page.total_openings-offset)
    ||page.items.some(item=>!item||!exact(item,['member_index','path','result_sha256','members_sha256','open_sha256','sha256','size_bytes'],['source_as_of_seq'])
     ||!Number.isSafeInteger(item.member_index)||item.member_index<0||item.member_index>33554432||typeof item.path!=='string'||!item.path||item.path.length>32768||item.path.includes('\0')
     ||![item.result_sha256,item.members_sha256,item.open_sha256,item.sha256].every(sha)||!Number.isSafeInteger(item.size_bytes)||item.size_bytes<0||item.size_bytes>512*1024*1024
     ||item.source_as_of_seq!==undefined&&!seq(item.source_as_of_seq))
    ||new Set(page.items.map(item=>item.open_sha256)).size!==page.items.length
    ||(offset+page.items.length<page.total_openings?page.next_offset_openings!==offset+page.items.length:page.next_offset_openings!==undefined))throw Error('留存打开版本的来源或分页尚未确认');
   controller.signal.throwIfAborted();setState({identity,offset,page});
  };
  void load().catch(error=>{
   if(controller.signal.aborted||taskDraftScope()!==owner)return;
   const message=error instanceof ApiError&&error.status===404?'此步骤暂无可确认的留存来源。'
    :error instanceof ApiError&&error.status===409?'留存记录或原活动来源未能核对，请刷新列表。'
    :error instanceof ApiError&&error.status===429?'文件读取正在占用容量，请稍后重试。'
    :error instanceof ApiError?'留存来源暂不可用，请刷新会话或稍后重试。':error instanceof Error?error.message:'留存版本暂不可用。';
   setState({identity,offset,error:message});
  });
  return()=>controller.abort();
 },[identity,offset,expected,revision]);
 const current=state?.identity===identity&&state.offset===offset?state:undefined,page=current?.page;
 const source=(item:Opening):NativeMemberPreviewSource=>({conversationId,runId:target.runId,activityId:target.activityId,resultSha:item.result_sha256,membersSha:item.members_sha256,
  member:{index:item.member_index,path:item.path},...(item.source_as_of_seq!==undefined?{asOfSeq:item.source_as_of_seq}:{})});
 const refresh=()=>{setCursor({identity,offset:0,previous:[]});setRevision(value=>value+1);};
 return <><section lang={language} aria-label={t('已留存的原生打开版本','Retained Native Opened Versions')} data-chat-search-ignore>
  <h4>{t('已留存的打开版本','Retained Opened Versions')}</h4>
  <p>{t('这些是曾经打开并留存的内容，不代表任务执行时的文件状态。打开时会再次核对完整内容和原活动权限。','These contents were opened and retained previously. They do not represent file state at task execution time. Opening them rechecks the complete content and original activity permissions.')}</p>
  <button type="button" onClick={refresh}>{t('刷新留存版本','Refresh Retained Versions')}</button>
  {(!current||!page&&!current.error)&&<p role="status">{t('正在读取留存版本…','Reading retained versions…')}</p>}
  {page&&<>
   {page.total_openings===0?<p role="status">{t('此步骤没有可核对的留存打开版本。','This step has no verifiable retained opened versions.')}</p>:<ol start={offset+1} style={{maxHeight:'24rem',overflow:'auto'}}>
    {page.items.map(item=><li key={item.open_sha256}><code style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.path}</code>
     <p>{t('打开版本','Opened Version')} <code>{item.open_sha256.slice(0,12)}</code> · {t(`${item.size_bytes} 字节`,`${item.size_bytes} bytes`)} · {t('内容摘要','Content Digest')} <code>{item.sha256}</code></p>
     <button type="button" onClick={()=>setSelected({identity,item})}>{t('预览此留存版本','Preview This Retained Version')}</button>{' '}
     <a href={nativeMemberDownloadUrl(source(item))+'&open_sha256='+item.open_sha256} download={item.path.split(/[\\/]/).at(-1)||'file'} onClick={event=>{if(taskDraftScope()!==owner)event.preventDefault();}}>{t('下载此原版本','Download This Original Version')}</a>
    </li>)}
   </ol>}
   <nav aria-label={t('留存打开版本翻页','Retained Opened Version Pages')}><button type="button" disabled={!currentCursor.previous.length} onClick={()=>setCursor({identity,offset:currentCursor.previous.at(-1)!,previous:currentCursor.previous.slice(0,-1),sha:page.openings_sha256})}>{t('上一页版本','Previous Version Page')}</button>
    <span>{Math.min(offset+1,page.total_openings)}–{offset+page.items.length} / {page.total_openings}</span>
    <button type="button" disabled={page.next_offset_openings===undefined} onClick={()=>{if(page.next_offset_openings!==undefined)setCursor({identity,offset:page.next_offset_openings,previous:[...currentCursor.previous,offset],sha:page.openings_sha256});}}>{t('下一页版本','Next Version Page')}</button></nav>
  </>}
  {current?.error&&<p role="alert">{conversationUiError(current.error,language)}</p>}
 </section>
 {selected?.identity===identity&&<><button lang={language} type="button" onClick={()=>setSelected(undefined)}>{t('关闭留存版本预览','Close Retained Version Preview')}</button>
  <ConversationDisplayBoundary key={selected.item.open_sha256} label={t('留存原版本预览','Retained Original Version Preview')}><Suspense fallback={<p lang={language} role="status">{t('正在载入原版本查看器…','Loading original version viewer…')}</p>}><NativeSearchFile key={selected.item.open_sha256} source={source(selected.item)} expected={{openSha:selected.item.open_sha256,sha256:selected.item.sha256,size:selected.item.size_bytes}}/></Suspense></ConversationDisplayBoundary>
 </>}
 </>;
}
