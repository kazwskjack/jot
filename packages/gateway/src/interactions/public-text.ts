function object(value:unknown):Record<string,unknown>|undefined{
 return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}

/** Search only the fields rendered in the readonly public interaction record. */
export function interactionTextFields(value:Record<string,unknown>):string[]{
 const fields:string[]=[];
 const add=(text:unknown,optional=false)=>{
  if(optional&&text===undefined)return;
  if(typeof text!=='string')throw Error('interaction_history_source_invalid');
  fields.push(text);
 };
 if(value.kind==='approval'){
  add(value.action_summary);add(value.risk);
  if(value.decision!==undefined){
   if(!['approve','deny'].includes(String(value.decision)))throw Error('interaction_history_source_invalid');
   add(value.decision==='approve'?'批准':'拒绝');
  }
  return fields;
 }
 const optionIds=new Map<string,Set<string>>();
 if(value.kind!=='question'||!Array.isArray(value.questions))throw Error('interaction_history_source_invalid');
 for(const candidate of value.questions){
  const question=object(candidate);
  if(!question||typeof question.question_id!=='string'||!Array.isArray(question.options))throw Error('interaction_history_source_invalid');
  const ids=new Set<string>();
  add(question.prompt);add(question.description,true);
  for(const candidate of question.options){
   const option=object(candidate);
   if(!option||typeof option.option_id!=='string')throw Error('interaction_history_source_invalid');
   ids.add(option.option_id);
   add(option.label);add(option.description,true);
  }
  optionIds.set(question.question_id,ids);
 }
 if(value.answers!==undefined){
  if(!Array.isArray(value.answers))throw Error('interaction_history_source_invalid');
  for(const candidate of value.answers){
   const answer=object(candidate);
   if(!answer||typeof answer.question_id!=='string'||!Array.isArray(answer.selected_option_ids))throw Error('interaction_history_source_invalid');
   for(const selected of answer.selected_option_ids){
    if(typeof selected!=='string')throw Error('interaction_history_source_invalid');
    if(!optionIds.get(answer.question_id)?.has(selected))add(`原选项 ${selected}`);
   }
   add(answer.custom_text,true);
  }
 }
 return fields;
}
