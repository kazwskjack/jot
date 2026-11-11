export function selectedModel(options,selection){return options.find(option=>option.provider===selection?.provider&&option.model===selection?.model);}
function defaultEffort(option){
 if(option?.compatibility)return option.compatibility.default_reasoning_effort??undefined;
 const efforts=option?.supported_reasoning_efforts??[];
 return efforts.includes('high')?'high':efforts[0];
}
export function selectedEffort(options,selection){return selection?.reasoning_effort??defaultEffort(selectedModel(options,selection));}
export function modelCapabilitySummary(option,language='zh-CN'){
 const text=(zh,en)=>language==='en'?en:zh,info=option?.compatibility;
 if(!info)return text('能力未知','Capabilities unknown');
 const modalities=info.input_modalities===null?text('输入能力未知','Input capabilities unknown'):info.input_modalities.map(value=>({text:text('文本','Text'),image:text('图像','Image')}[value]??value)).join('/')||text('无声明输入模态','No input modalities declared');
 const number=value=>value===null?text('未知','Unknown'):new Intl.NumberFormat(language==='en'?'en':'zh-CN').format(value);
 return language==='en'?`${modalities} · Context ${number(info.context_window)} · Default output ${number(info.default_max_tokens)} · Metadata ${info.metadata_digest.slice(0,8)}`:`${modalities} · 上下文 ${number(info.context_window)} · 默认输出 ${number(info.default_max_tokens)} · 元数据 ${info.metadata_digest.slice(0,8)}`;
}
export function modelSelection(option){
 const effort=defaultEffort(option);
 return {provider:option.provider,model:option.model,...(effort?{reasoning_effort:effort}:{})};
}
export function nextEffort(options,selection){
 const efforts=selectedModel(options,selection)?.supported_reasoning_efforts??[];
 if(!efforts.length)return undefined;
 const current=selectedEffort(options,selection);
 return efforts[(efforts.indexOf(current)+1)%efforts.length];
}
export function isSubmitKey(event,sendByCtrlEnter=false){return Boolean(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229&&(!sendByCtrlEnter||event.ctrlKey||event.metaKey));}
/** @param {{focused?:boolean,value?:string,hasAttachments?:boolean,voiceActive?:boolean,menu?:'model'|'fallback'|'more'|null}} options */
export function isComposerExpanded({focused=false,value='',hasAttachments=false,voiceActive=false,menu=null}){return Boolean(focused||value.trim()||hasAttachments||voiceActive||menu);}
