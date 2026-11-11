import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import React,{useEffect,useRef,useState} from 'react';
import type {Interaction} from './types';
import TaskReviewFiles from './TaskReviewFiles';

/** A stable request survives receipt loss. A different answer is a new request. */
export default function InteractionCard({value,disabled,submit,onRefresh}:{value:Interaction;disabled:boolean;submit:(body:unknown,key:string,signal:AbortSignal)=>Promise<{accepted:boolean;interaction_id:string}>;onRefresh:()=>Promise<void>}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const [answers,setAnswers]=useState<Record<string,{selected_option_ids:string[];custom_text:string}>>({});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[accepted,setAccepted]=useState(false);
 const locked=useRef(false),keys=useRef(new Map<string,string>()),current=useRef<AbortController|null>(null);
 useEffect(()=>()=>{current.current?.abort()},[]);
 const send=async(body:unknown)=>{
  if(disabled||locked.current||accepted)return;
  locked.current=true;setBusy(true);setError('');const controller=new AbortController();current.current=controller;
  const identity=JSON.stringify([value.interaction_id,value.version,body]),key=keys.current.get(identity)??crypto.randomUUID();keys.current.set(identity,key);
  try{
   const receipt=await submit(body,key,controller.signal);
   if(controller.signal.aborted)return;
   if(receipt.accepted!==true||receipt.interaction_id!==value.interaction_id)throw new Error('interaction_receipt_unconfirmed');
   setAccepted(true);await onRefresh();
  }catch(e){
   if(controller.signal.aborted)return;
   const status=(e as {status?:number}).status??0;
   setError([403,404,409].includes(status)?'状态或权限已更新，请核对最新卡片。':status>=400&&status<500?'请检查回答内容后重试。':'提交结果尚未确认；可用同一回答重试。');
   if([403,404,409].includes(status))await onRefresh().catch(()=>{});
  }finally{if(!controller.signal.aborted){locked.current=false;setBusy(false);}}
 };
 const blocked=disabled||busy||accepted;
 const browserAction=value.kind==='approval'&&value.purpose==='browser_action';
 const review=value.kind==='approval'&&!!value.purpose&&!browserAction;
 const replyReview=value.kind==='approval'&&value.purpose==='task_reply_review';
 const acceptance=value.kind==='question'&&value.purpose==='task_acceptance_review';
 return <section lang={language} className="jot-interaction"><h3>{browserAction?t('确认浏览器操作','Confirm Browser Action'):replyReview?t('确认这份回复','Confirm This Reply'):acceptance?t('逐项验收结果','Review Each Result'):review?t('确认继续核验','Confirm Continued Review'):value.kind==='approval'?t('需要你的确认','Your Confirmation Is Required'):t('补充一下信息','Provide More Information')}</h3>
 {acceptance&&<TaskReviewFiles id={value.interaction_id} version={value.version} disabled={blocked} onRefresh={onRefresh}/>}
 {value.kind==='approval'?<><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{value.action_summary}</p>{!review&&<small>{t('风险：','Risk: ')}{value.risk}</small>}
 <button disabled={blocked} onClick={()=>void send({expected_version:value.version,action_digest:value.action_digest,decision:'approve'})}>{browserAction?t('批准此浏览器操作','Approve This Browser Action'):replyReview?t('确认这份回复','Confirm This Reply'):review?t('确认并继续核验','Confirm and Continue Review'):t('批准本次操作','Approve This Action')}</button>
 <button disabled={blocked} onClick={()=>void send({expected_version:value.version,action_digest:value.action_digest,decision:'deny'})}>{browserAction?t('拒绝此浏览器操作','Deny This Browser Action'):replyReview?t('拒绝这份回复','Reject This Reply'):review?t('暂不继续','Do Not Continue Yet'):t('拒绝','Deny')}</button></>:<>
 {value.questions.map(q=><fieldset key={q.question_id} disabled={blocked}><legend>{q.prompt}</legend>{q.description&&<>{acceptance&&<small>{t('待验收的结果','Result Awaiting Review')}</small>}<p style={{whiteSpace:'pre-wrap'}}>{q.description}</p></>}{q.options.map(o=><label key={o.option_id}><input type={q.multiple?'checkbox':'radio'} name={`${value.interaction_id}-${q.question_id}`} checked={answers[q.question_id]?.selected_option_ids.includes(o.option_id)??false} onChange={e=>setAnswers(v=>({...v,[q.question_id]:{custom_text:v[q.question_id]?.custom_text??'',selected_option_ids:q.multiple?(e.target.checked?[...(v[q.question_id]?.selected_option_ids??[]),o.option_id]:(v[q.question_id]?.selected_option_ids??[]).filter(x=>x!==o.option_id)):[o.option_id]}}))}/>{o.label}</label>)}
 {q.allow_custom&&<input aria-label={q.prompt} placeholder={acceptance?t('补充说明（可选）','Additional notes (optional)'):undefined} maxLength={value.purpose==='task_input'||acceptance?10000:undefined} value={answers[q.question_id]?.custom_text??''} onChange={e=>setAnswers(v=>({...v,[q.question_id]:{selected_option_ids:v[q.question_id]?.selected_option_ids??[],custom_text:e.target.value}}))}/>}</fieldset>)}
 <button disabled={blocked||(value.purpose==='task_input'&&!value.questions.every(q=>answers[q.question_id]?.custom_text.trim()))||(acceptance&&!value.questions.every(q=>answers[q.question_id]?.selected_option_ids.length===1))} onClick={()=>void send({expected_version:value.version,answers:value.questions.map(q=>({question_id:q.question_id,...(answers[q.question_id]??{selected_option_ids:[],custom_text:''})}))})}>{acceptance?t('提交验收','Submit Review'):value.purpose==='task_input'?t('提交信息并继续','Submit Information and Continue'):t('提交回答','Submit Answer')}</button>
 </>}{accepted&&<p role="status">{replyReview?t('草稿审核已记录；发送仍需复核，不代表已送达。','The draft review was recorded. Sending still requires verification; this does not mean it was delivered.'):acceptance?t('验收已保存，未通过的项目会保留为待处理。','The review was saved. Items that did not pass remain pending.'):t('已收到，正在同步任务进度。','Received. Synchronizing task progress.')}</p>}{error&&<p role="alert">{conversationUiError(error,language)}</p>}</section>;
}
