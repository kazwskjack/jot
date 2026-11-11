import React,{useId,useMemo} from 'react';
import type {NativeTodoInput} from './types';
import {taskDraftScope} from './client';
import {toolResultTasks} from './tool-result-tasks';
import ToolResultTaskList from './ToolResultTaskList';
import ToolResultText from './ToolResultText';

export default function NativeTodoInputContent({value,sourceKey}:{value:NativeTodoInput;sourceKey:string}){
 const instance=useId(),identity=JSON.stringify(['native-todo-input',taskDraftScope(),sourceKey,instance]);
 const tasks=useMemo(()=>value.format==='items'?toolResultTasks({todos:value.items}):value.format==='markdown'?toolResultTasks(value.text):undefined,[value]);
 if(value.format==='source_limit')return <p role="status" data-chat-search-ignore>原调用输入超过公开展示范围，当前未展开完整清单。</p>;
 return <section aria-label="原生工具公开清单输入">
  {tasks?<ToolResultTaskList value={tasks} documentId={identity} origin="input"/>:value.format==='markdown'?<ToolResultText text={value.text} identity={identity+':text'}/>:null}
  <details><summary>公开清单输入数据</summary><ToolResultText text={JSON.stringify(value)} identity={identity+':data'}/></details>
 </section>;
}
