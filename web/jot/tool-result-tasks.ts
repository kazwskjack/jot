// Task/todo presentation adapted from PilotDeck 783499ff TodoListContent/TaskListContent.
// Adapted portions retain AGPL-3.0; see packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt.
export type ResultTask={sourceRange?:{start:number;end:number};title:string;id?:string;status?:string;marker?:'checked'|'unchecked';owner?:string;priority?:string;blockedBy?:string[];metadataUnconfirmed?:boolean};
export type ResultTasks={items:ResultTask[];unconfirmed:number};
const object=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
function arrayTasks(values:unknown[],explicit:boolean):ResultTasks|undefined{
 const items:ResultTask[]=[];let unconfirmed=0;
 for(const value of values){
  const row=object(value),title=row?.content??row?.subject??row?.title;
  if(!row||typeof title!=='string'){unconfirmed++;continue;}
  const id=typeof row.id==='string'?row.id:typeof row.id==='number'&&Number.isSafeInteger(row.id)?String(row.id):undefined;
  const status=typeof row.status==='string'?row.status:undefined,owner=typeof row.owner==='string'?row.owner:undefined,priority=typeof row.priority==='string'?row.priority:undefined;
  const blockedBy=Array.isArray(row.blockedBy)&&row.blockedBy.every(value=>typeof value==='string')?row.blockedBy as string[]:undefined;
  const metadataUnconfirmed=['status','owner','priority'].some(key=>row[key]!==undefined&&typeof row[key]!=='string')||row.blockedBy!==undefined&&!blockedBy||row.id!==undefined&&id===undefined;
  items.push({title,...(id!==undefined?{id}:{}),...(status!==undefined?{status}:{}),...(owner!==undefined?{owner}:{}),...(priority!==undefined?{priority}:{}),...(blockedBy?{blockedBy}:{}),...(metadataUnconfirmed?{metadataUnconfirmed:true}:{})});
 }
 return items.length||explicit?{items,unconfirmed}:undefined;
}
function structuredTasks(value:unknown):ResultTasks|undefined{
 if(Array.isArray(value))return arrayTasks(value,false);
 const row=object(value);if(!row)return;
 if(Array.isArray(row.todos))return arrayTasks(row.todos,true);
 if(Array.isArray(row.tasks))return arrayTasks(row.tasks,true);
}
/** View-only evidence from an already verified result; missing statuses are never defaulted to pending/running. */
export function toolResultTasks(value:unknown):ResultTasks|undefined{
 if(typeof value!=='string')return structuredTasks(value);
 if(value.length>512*1024)return;
 const trimmed=value.trim();if(trimmed.startsWith('{')||trimmed.startsWith('['))try{const structured=structuredTasks(JSON.parse(trimmed));if(structured)return structured;}catch{}
 const items:ResultTask[]=[];let sourceOffset=0;
 for(const line of value.split(/\r?\n/)){
  const sourceRange={start:sourceOffset,end:sourceOffset+line.length};
  sourceOffset=sourceRange.end+(value.slice(sourceRange.end,sourceRange.end+2)==='\r\n'?2:1);
  const checkbox=/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
  if(checkbox){items.push({sourceRange,title:checkbox[2]!,marker:checkbox[1]===' '?'unchecked':'checked'});continue;}
  const task=/^(?:-\s*)?#([0-9]{1,64})\.?\s+(.+)$/.exec(line.trimStart());if(!task)continue;
  let title=task[2]!,status:string|undefined;
  if(title.startsWith('[')){const end=title.indexOf(']');if(end>1&&end<=65){status=title.slice(1,end);title=title.slice(end+1).trimStart();}}
  if(status===undefined){const suffix=/\(status:\s*([A-Za-z_]{1,64})\)\s*$/.exec(title);if(suffix){status=suffix[1];title=title.slice(0,suffix.index).trimEnd();}}
  items.push({sourceRange,id:task[1]!,title,...(status!==undefined?{status}:{})});
 }
 return items.length?{items,unconfirmed:0}:undefined;
}
