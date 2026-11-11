import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import NativeFileOpenings from './NativeFileOpenings';
import NativeSearchMembers from './NativeSearchMembers';
import ActivityToolFile from './ActivityToolFile';
import React,{lazy,Suspense,useEffect,useRef,useState} from 'react';
import {ApiError,request,taskDraftScope} from './client';
import type {ActivityToolResultPage,ActivityToolResultFile} from './types';

type Target={nativeSource?:boolean;asOfSeq?:string;runId:string;activityId:string;toolName:string;offset?:number;resultSha?:string;textSha?:string;match?:{offset:number;text:string}};
const sha=/^[a-f0-9]{64}$/;
const McpResultContent=lazy(()=>import('./McpResultContent'));

export default function ActivityToolResult({conversationId,target}:{conversationId:string;target:Target}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),sourceIdentity=JSON.stringify([owner,conversationId,target]);
 const [jsonSource,setJsonSource]=useState<string>(),json=jsonSource===sourceIdentity,identity=JSON.stringify([sourceIdentity,json?'json':'text']);
 const region=useRef<HTMLDivElement>(null);
 const [cursor,setCursor]=useState<{identity:string;offset:number;previous:number[];sha?:string;textSha?:string}>({identity,offset:target.offset??0,previous:[],sha:target.resultSha,textSha:target.textSha});
 const [state,setState]=useState<{identity:string;offset:number;page?:ActivityToolResultPage;error?:string}>();
 const [revision,setRevision]=useState(0);
 const [richSource,setRichSource]=useState<{identity:string;sha:string}>();
 const [membersIdentity,setMembersIdentity]=useState<string>(),[openingsIdentity,setOpeningsIdentity]=useState<string>();
 const [selected,setSelected]=useState<{identity:string;resultSha:string;file:ActivityToolResultFile}>();
 const currentCursor:typeof cursor=cursor.identity===identity?cursor:{identity,offset:json?0:target.offset??0,previous:[],sha:target.resultSha,textSha:json?undefined:target.textSha};
 const {offset,sha:expected,textSha:expectedText}=currentCursor;
 useEffect(()=>{region.current?.focus();region.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  const controller=new AbortController();
  setState({identity,offset});
  const load=async()=>{
   const query=new URLSearchParams({run_id:target.runId,offset_chars:String(offset),...(json?{representation:'json'}:{}),...(target.nativeSource&&target.asOfSeq?{as_of_seq:target.asOfSeq}:{}),...(expected?{result_sha256:expected}:{}),...(expectedText?{text_sha256:expectedText}:{})});
   const page=await request<ActivityToolResultPage>(`/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(target.activityId)}/tool-result${target.nativeSource?'/source':''}?${query}`,'GET',undefined,undefined,controller.signal);
   if(taskDraftScope()!==owner||!page||page.representation!==(json?'json':undefined)||json&&(page.source!=='mcp'||page.text_sha256!==page.result_sha256)||page.conversation_id!==conversationId||page.run_id!==target.runId||page.activity_id!==target.activityId
    ||page.tool_name!==target.toolName||page.execution_authorized!==false||page.as_of_seq!==(target.nativeSource?target.asOfSeq:undefined)
    ||(target.toolName==='jot_workspace'
     ?page.source!=='workspace'||!['files.read','web.read','files.write','files.delete','files.list'].includes(page.operation??'')||typeof page.source_truncated!=='boolean'
     :target.toolName==='glob'||target.toolName==='grep'
      ?page.source!=='native'||page.operation!==target.toolName||typeof page.source_truncated!=='boolean'||page.has_other_content!==false
      :page.source!=='mcp'||page.operation!==undefined||page.source_truncated!==undefined)
    ||(target.nativeSource
     ?page.source!=='native'||page.native_source_scope!==(target.toolName==='glob'?'all_paths':'all_entries_with_native_line_previews')
      ||page.source_truncated!==(target.toolName==='grep')||typeof page.source_bytes!=='number'||!Number.isSafeInteger(page.source_bytes)
      ||page.source_bytes<0||page.source_bytes>33554432||page.total_chars>page.source_bytes
     :page.native_source_scope!==undefined||page.source_bytes!==undefined)
    ||((page.operation==='files.write'||page.operation==='files.delete')? !['available','base_unrecorded','preview_limit','content_unavailable','non_text'].includes(page.file_diff_state??''):page.file_diff_state!==undefined)
    ||typeof page.result_sha256!=='string'||!sha.test(page.result_sha256)||expected!==undefined&&page.result_sha256!==expected
    ||typeof page.text_sha256!=='string'||!sha.test(page.text_sha256)||expectedText!==undefined&&page.text_sha256!==expectedText||page.offset_chars!==offset
    ||!Number.isSafeInteger(page.total_chars)||page.total_chars<offset||page.total_chars>(target.nativeSource?33554432:6*1048576)
    ||typeof page.text!=='string'||page.text.length>16384||offset+page.text.length>page.total_chars||typeof page.has_other_content!=='boolean'
    ||(page.next_offset_chars===undefined?offset+page.text.length!==page.total_chars
     :!page.text.length||page.next_offset_chars!==offset+page.text.length||page.next_offset_chars>=page.total_chars))throw Error('工具结果来源或分页尚未确认');
   if(page.operation==='files.list'){
    if(!Array.isArray(page.file_links)||page.file_links.length>256||page.file_links.some((file,index,files)=>!file||typeof file.path!=='string'||!file.path||file.path.length>4096
     ||!Number.isSafeInteger(file.version)||file.version<0||!Number.isSafeInteger(file.size)||file.size<0||typeof file.sha256!=='string'||!sha.test(file.sha256)
     ||!Number.isSafeInteger(file.offset_chars)||file.offset_chars<0||!Number.isSafeInteger(file.end_offset_chars)||file.end_offset_chars<=file.offset_chars||file.end_offset_chars>page.total_chars
     ||file.end_offset_chars<=offset||file.offset_chars>=offset+page.text.length||index>0&&file.offset_chars<files[index-1]!.end_offset_chars))throw Error('原文件列表来源尚未确认');
   }else if(page.file_links!==undefined)throw Error('原文件列表来源尚未确认');
   if(!json&&target.match&&offset===(target.offset??0)
    &&(target.match.offset<offset||page.text.slice(target.match.offset-offset,target.match.offset-offset+target.match.text.length)!==target.match.text))throw Error('原结果命中位置尚未确认');
   if(!controller.signal.aborted)setState({identity,offset,page});
  };
  void load().catch(error=>{
   if(controller.signal.aborted)return;
   const message=json&&error instanceof ApiError&&error.status===400?'当前服务尚未确认原始MCP结果JSON视图，可返回文本视图。':error instanceof ApiError&&error.status===404?(target.nativeSource?'此步骤暂无可确认的大结果来源。':'此步骤暂无已保存且可确认的结果正文。')
    :error instanceof ApiError&&error.status===409?'正文来源已变化，请关闭后重新打开。'
    :error instanceof Error?error.message:'工具结果读取失败';
   setState({identity,offset,error:message});
  });
  return()=>controller.abort();
 },[identity,offset,expected,expectedText,revision]);
 const current=state?.identity===identity&&state.offset===offset?state:undefined,page=current?.page;
 const match=!json&&page&&target.match&&target.match.offset>=offset&&target.match.offset+target.match.text.length<=offset+page.text.length
  &&page.text.slice(target.match.offset-offset,target.match.offset-offset+target.match.text.length)===target.match.text?target.match:undefined;
 return <div lang={language} ref={region} tabIndex={-1} className="jot-activity-content" aria-label={target.nativeSource?t('原生大结果来源','Native Large-Result Source'):t('工具结果正文','Tool Result Body')}>
  <h4>{target.nativeSource?t('原生大结果来源','Native Large-Result Source'):t('工具结果正文','Tool Result Body')}</h4>
  {!target.nativeSource&&(json||page?.source==='mcp')&&<button type="button" data-chat-search-ignore aria-pressed={json} onClick={()=>{
   const nextJson=!json;setJsonSource(nextJson?sourceIdentity:undefined);
   setCursor({identity:JSON.stringify([sourceIdentity,nextJson?'json':'text']),offset:nextJson?0:target.offset??0,previous:[],sha:page?.result_sha256??expected,...(!nextJson&&target.textSha?{textSha:target.textSha}:{})});
  }}>{json?t('返回工具文本视图','Return to Tool Text View'):t('查看原始结果JSON','View Original Result JSON')}</button>}
  {!target.nativeSource&&(page?.source==='mcp'||richSource?.identity===sourceIdentity)&&<button type="button" data-chat-search-ignore aria-expanded={richSource?.identity===sourceIdentity}
   onClick={()=>{if(richSource?.identity===sourceIdentity)setRichSource(undefined);else if(page?.source==='mcp')setRichSource({identity:sourceIdentity,sha:page.result_sha256});}}>{richSource?.identity===sourceIdentity?t('关闭结果内容项','Close Result Content Items'):t('查看内嵌文件与结果项','View Embedded Files and Result Items')}</button>}
  {richSource?.identity===sourceIdentity&&<ConversationDisplayBoundary key={richSource.sha} label={t('原结果内容项','Original Result Content Items')}><Suspense fallback={<p role="status">{t('正在载入结果内容查看器…','Loading result content viewer…')}</p>}><McpResultContent source={{conversationId,runId:target.runId,activityId:target.activityId,toolName:target.toolName,resultSha:richSource.sha}}/></Suspense></ConversationDisplayBoundary>}
  {json&&<p>{t('原始JSON可能包含非文本结果的编码数据，按同一原工具结果保存的内容分页显示。','Original JSON may contain encoded non-text data. Pages show content saved in the same original tool result.')}</p>}
  {(target.toolName==='glob'||target.toolName==='grep')&&<>
   <button type="button" data-chat-search-ignore aria-expanded={membersIdentity===identity} onClick={()=>{setOpeningsIdentity(undefined);setMembersIdentity(membersIdentity===identity?undefined:identity);}}>{membersIdentity===identity?t('关闭文件成员','Close File Members'):t('查看文件成员','View File Members')}</button>
   <button type="button" data-chat-search-ignore aria-expanded={openingsIdentity===identity} onClick={()=>{setMembersIdentity(undefined);setOpeningsIdentity(openingsIdentity===identity?undefined:identity);}}>{openingsIdentity===identity?t('关闭留存版本','Close Retained Versions'):t('查看留存打开版本','View Retained Opened Versions')}</button>
   {openingsIdentity===identity&&<div lang={language}><NativeFileOpenings key={identity} conversationId={conversationId} target={{runId:target.runId,activityId:target.activityId,toolName:target.toolName,...(target.asOfSeq!==undefined?{asOfSeq:target.asOfSeq}:{})}}/></div>}
   {membersIdentity===identity&&<div lang={language}><NativeSearchMembers key={identity} conversationId={conversationId} target={{runId:target.runId,activityId:target.activityId,toolName:target.toolName,...(target.asOfSeq?{asOfSeq:target.asOfSeq}:{})}}/></div>}
  </>}
  {(!current||!page&&!current.error)&&<p role="status">{t('正在读取原工具结果…','Reading original tool result…')}</p>}
  {page&&<>
   <section data-chat-search-content={JSON.stringify(['tool-result',identity,page.result_sha256,offset])}>
    <pre>{match?<>{page.text.slice(0,match.offset-offset)}<mark>{match.text}</mark>{page.text.slice(match.offset-offset+match.text.length)}</>:page.text}</pre>
   </section>
   {page.file_diff_state&&page.file_diff_state!=='available'&&<p role="status">{{base_unrecorded:t('该文件变更缺少原版本正文，当前显示已确认的操作信息。','This file change has no original-version body. Verified operation information is shown.'),preview_limit:t('差异来源超过单文件 1 MiB 的文本比较范围。','The diff source exceeds the 1 MiB per-file text comparison limit.'),content_unavailable:t('固定版本内容暂不可用，当前显示已确认的操作信息。','Pinned-version content is unavailable. Verified operation information is shown.'),non_text:t('差异来源包含非 UTF-8 文本内容。','The diff source contains content that is not UTF-8 text.')}[page.file_diff_state]}</p>}
   {page.file_links&&page.file_links.length>0&&<div role="group" aria-label={t('原列表固定版本文件','Pinned Versions from the Original File List')} data-chat-search-ignore style={{display:'flex',flexWrap:'wrap',gap:'0.25rem',maxHeight:'12rem',overflow:'auto'}}>
    {page.file_links.map(file=><button type="button" key={JSON.stringify([file.path,file.version,file.sha256])} title={file.path} aria-label={t(`${file.path}，版本 ${file.version}`,`${file.path}, version ${file.version}`)}
     onClick={()=>setSelected({identity,resultSha:page.result_sha256,file})}>{file.path.split('/').at(-1)} · {t('版本','Version')} {file.version}</button>)}
   </div>}
   {page.native_source_scope&&<p role="status">{page.native_source_scope==='all_paths'?t('显示原生保存的全部路径。','Showing all paths saved by the native tool.'):t('显示原生保存的全部命中条目，行文本沿用原生预览范围。','Showing all matching entries saved by the native tool. Line text retains the native preview bounds.')}</p>}
   {page.source_truncated&&!page.native_source_scope&&<p role="status">{page.source==='native'?t('原生公开结果未覆盖全部来源，当前显示已保留内容。','The native public result does not cover the full source. Retained content is shown.'):page.operation==='files.list'?t('原文件列表含后续页面或超出显示范围，当前展示已确认的留存部分。','The original file list has later pages or exceeds display limits. The verified retained portion is shown.'):t('原工具回执中的正文已截断，当前显示回执保存的全部文本。','The original tool receipt truncated its body. All text saved in the receipt is shown.')}</p>}
   {page.total_chars===0&&<p role="status">{t('原结果未包含文本内容。','The original result contains no text.')}</p>}
   {page.has_other_content&&<p role="status">{t('原结果还包含图片或其他非文本内容。','The original result also contains images or other non-text content.')}</p>}
   {offset>0&&<button type="button" data-chat-search-ignore onClick={()=>setCursor({identity,offset:0,previous:[],sha:page.result_sha256,textSha:page.text_sha256})}>{t('从正文开头阅读','Read from the Start of the Body')}</button>}
   <nav aria-label={t('工具结果正文翻页','Tool Result Body Pages')} data-chat-search-ignore>
    <button type="button" disabled={!currentCursor.previous.length} onClick={()=>{
     const previous=currentCursor.previous.slice(0,-1),prior=currentCursor.previous.at(-1)!;
     setCursor({identity,offset:prior,previous,sha:page.result_sha256,textSha:page.text_sha256});
    }}>{t('上一页正文','Previous Body Page')}</button>
    <span>{Math.min(offset+1,page.total_chars)}–{offset+page.text.length} / {page.total_chars}{t('（UTF-16 位置）',' (UTF-16 positions)')}</span>
    <button type="button" disabled={page.next_offset_chars===undefined} onClick={()=>{
     if(page.next_offset_chars!==undefined)setCursor({identity,offset:page.next_offset_chars,previous:[...currentCursor.previous,offset],sha:page.result_sha256,textSha:page.text_sha256});
    }}>{t('下一页正文','Next Body Page')}</button>
   </nav>
  </>}
  {current?.error&&<p role="alert">{conversationUiError(current.error,language)} <button type="button" onClick={()=>setRevision(value=>value+1)}>{t('重试读取','Retry Reading')}</button></p>}
  {selected?.identity===identity&&<>
   <button type="button" data-chat-search-ignore onClick={()=>setSelected(undefined)}>{t('关闭原列表文件','Close Original List File')}</button>
   <div lang={language}><ActivityToolFile key={JSON.stringify(selected)} conversationId={conversationId} runId={target.runId} activityId={target.activityId} resultSha={selected.resultSha} file={selected.file}/></div>
  </>}
 </div>;
}
