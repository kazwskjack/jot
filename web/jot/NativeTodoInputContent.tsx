import {useApplicationLanguage,useApplicationText} from './application-language';
import React,{useEffect,useId,useMemo,useRef} from 'react';
import type {NativeTodoInput} from './types';
import {taskDraftScope} from './client';
import {toolResultTasks} from './tool-result-tasks';
import ToolResultTaskList from './ToolResultTaskList';
import ToolResultText from './ToolResultText';
import {nativeTodoSearchText,type ActivityReveal} from './activity-presentation';

export default function NativeTodoInputContent({value,sourceKey,reveal}:{value:NativeTodoInput;sourceKey:string;reveal?:ActivityReveal}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const instance=useId(),scope=taskDraftScope(),identity=JSON.stringify(['native-todo-input',scope,sourceKey,instance]);
 const text=useMemo(()=>nativeTodoSearchText(value),[value]),plain=useRef<HTMLDetailsElement>(null),appliedReveal=useRef('');
 const match=reveal?.todo,valid=!!match&&match.scope===scope&&match.sourceKey===sourceKey&&match.text===text
  &&Number.isSafeInteger(match.offset)&&Number.isSafeInteger(match.length)&&match.offset>=0&&match.length>0&&match.offset+match.length<=text.length;
 useEffect(()=>{if(valid&&reveal&&appliedReveal.current!==reveal.key&&plain.current){appliedReveal.current=reveal.key;plain.current.open=true;}},[valid,reveal?.key]);
 const tasks=useMemo(()=>value.format==='items'?toolResultTasks({todos:value.items}):value.format==='markdown'?toolResultTasks(value.text):undefined,[value]);
 if(value.format==='source_limit')return <p lang={language} role="status" data-chat-search-ignore>{t("原调用输入超过公开展示范围，当前未展开完整清单。","The original call input exceeds public display limits. The full list is not expanded here.")}</p>;
 return <section lang={language} aria-label={t("原生工具公开清单输入","Native Tool Public Task List Input")}>
  {tasks?<ToolResultTaskList value={tasks} documentId={identity} origin="input" {...(valid&&match?.itemIndex!==undefined?{reveal:{key:reveal!.key,itemIndex:match.itemIndex}}:{})}/>:value.format==='markdown'?<ToolResultText text={value.text} identity={identity+':text'}/>:null}
  <details ref={plain}><summary>{t('清单文字与原状态','Task List Text and Original Status')}</summary><ToolResultText text={text} identity={identity+':source'} sourceKey={JSON.stringify([scope,sourceKey])} {...(valid&&match?{reveal:{key:reveal!.key,offset:match.offset,length:match.length}}:{})}/></details>
  <details><summary>{t('公开清单输入数据','Public Task List Input Data')}</summary><ToolResultText text={JSON.stringify(value)} identity={identity+':data'}/></details>
 </section>;
}
