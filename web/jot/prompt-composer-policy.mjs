export function selectedModel(options,selection){return options.find(option=>option.provider===selection?.provider&&option.model===selection?.model);}
export function modelSelection(option){
 const efforts=option.supported_reasoning_efforts??[];
 const effort=efforts.includes('high')?'high':efforts[0];
 return {provider:option.provider,model:option.model,...(effort?{reasoning_effort:effort}:{})};
}
export function nextEffort(options,selection){
 const efforts=selectedModel(options,selection)?.supported_reasoning_efforts??[];
 if(!efforts.length)return undefined;
 const current=selection?.reasoning_effort??(efforts.includes('high')?'high':efforts[0]);
 return efforts[(efforts.indexOf(current)+1)%efforts.length];
}
export function isSubmitKey(event){return event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229;}
export function isComposerExpanded({focused=false,value='',hasAttachments=false,voiceActive=false,menu=null}){return Boolean(focused||value.trim()||hasAttachments||voiceActive||menu);}
