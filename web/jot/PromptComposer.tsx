import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {isComposerExpanded,isSubmitKey,modelSelection,nextEffort,selectedModel} from './prompt-composer-policy.mjs';

export type PromptSelection={provider:string;model:string;reasoning_effort?:string};
export type PromptModelOption={provider:string;model:string;label?:string;supported_reasoning_efforts:string[]};
export type PromptComposerProps={
 value:string;onChange:(value:string)=>void;onSubmit:()=>void;
 attachments?:React.ReactNode;hasAttachments?:boolean;onAttach?:()=>void;onDropFiles?:(files:File[])=>void;
 voiceControl?:React.ReactNode;voiceActive?:boolean;keepVoiceVisible?:boolean;
 responding?:boolean;onStop?:()=>void;disabled?:boolean;inputDisabled?:boolean;submitDisabled?:boolean;attachDisabled?:boolean;stopDisabled?:boolean;
 modelOptions?:PromptModelOption[];selection?:PromptSelection;onSelectionChange?:(selection:PromptSelection)=>void;
 goalMenu?:React.ReactNode;uploadMenu?:React.ReactNode;onGoalMode?:()=>void;
 placeholder?:string;ariaLabel?:string;maxLength?:number;submitLabel?:string;className?:string;onOpenChange?:(open:boolean)=>void;
};

function Glyph({kind}:{kind:'send'|'stop'|'model'|'effort'|'plus'}){
 return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{kind==='send'?<path d="M12 19V5m-6 6 6-6 6 6"/>:kind==='stop'?<rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>:kind==='model'?<><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></>:kind==='effort'?<><path d="M5 18v-4m7 4V9m7 9V5"/></>:<path d="M12 5v14M5 12h14"/>}</svg>;
}

/** Independent implementation from the public preview; material belongs to the host. */
export default function PromptComposer({value,onChange,onSubmit,attachments,hasAttachments=false,onAttach,onDropFiles,voiceControl,voiceActive=false,keepVoiceVisible=false,responding=false,onStop,disabled=false,inputDisabled=false,submitDisabled=false,attachDisabled=false,stopDisabled=disabled,modelOptions=[],selection,onSelectionChange,goalMenu,uploadMenu,onGoalMode,placeholder='输入消息…',ariaLabel='消息',maxLength=8000,submitLabel='发送',className='',onOpenChange}:PromptComposerProps){
 const root=useRef<HTMLDivElement>(null),textarea=useRef<HTMLTextAreaElement>(null),modelButton=useRef<HTMLButtonElement>(null),plusButton=useRef<HTMLButtonElement>(null),composing=useRef(false),dragDepth=useRef(0);
 const [focused,setFocused]=useState(false),[menu,setMenu]=useState<'model'|'more'|null>(null),[dragging,setDragging]=useState(false);
 const expanded=isComposerExpanded({focused,value,hasAttachments,voiceActive,menu});
 const model=selectedModel(modelOptions,selection) as PromptModelOption|undefined;
 const effort=selection?.reasoning_effort??(model?.supported_reasoning_efforts.includes('high')?'high':model?.supported_reasoning_efforts[0]);
 const canSend=!disabled&&!submitDisabled&&!voiceActive&&Boolean(value.trim()||hasAttachments);
 const moreMenu=Boolean(goalMenu||uploadMenu||onGoalMode);
 useEffect(()=>{onOpenChange?.(expanded);},[expanded,onOpenChange]);
 useEffect(()=>{
  const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target)){setMenu(null);setFocused(false);}};
  document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
 },[]);
 useEffect(()=>{if(disabled){setMenu(null);setDragging(false);dragDepth.current=0;}},[disabled]);
 useLayoutEffect(()=>{const input=textarea.current;if(!input)return;input.style.height='0px';const height=expanded?Math.min(176,Math.max(40,input.scrollHeight)):24;input.style.height=`${height}px`;input.style.overflowY=input.scrollHeight>176?'auto':'hidden';},[value,expanded]);
 const send=()=>{if(canSend)onSubmit();};
 const closeMenu=(restoreFocus=false)=>{if(restoreFocus)(menu==='model'?modelButton:plusButton).current?.focus();setMenu(null);};
 const menuKeys=(event:React.KeyboardEvent<HTMLDivElement>)=>{
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  if(!buttons.length)return;event.preventDefault();const current=buttons.indexOf(document.activeElement as HTMLButtonElement);
  const index=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?(current+1)%buttons.length:(current-1+buttons.length)%buttons.length;buttons[index]?.focus();
 };
 return <div ref={root} className={`jot-prompt-composer jot-composer-glass ${className}`} data-expanded={expanded} data-voice-active={voiceActive||undefined} data-dragging={dragging||undefined} aria-label="消息输入区" role="group"
  onFocusCapture={event=>{if(event.target===textarea.current||expanded)setFocused(true);}} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null)){setFocused(false);setMenu(null);}}}
  onKeyDown={event=>{if(event.key!=='Escape')return;if(menu){event.preventDefault();event.stopPropagation();closeMenu(true);}else if(!value.trim()&&!hasAttachments&&!voiceActive&&document.activeElement===textarea.current){event.preventDefault();event.stopPropagation();textarea.current?.blur();setFocused(false);}}}
  onDragEnter={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth.current++;if(!disabled&&!attachDisabled&&onDropFiles)setDragging(true);}}}
  onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=!disabled&&!attachDisabled&&onDropFiles?'copy':'none';}}}
  onDragLeave={()=>{dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setDragging(false);}}
  onDrop={event=>{event.preventDefault();dragDepth.current=0;setDragging(false);const files=Array.from(event.dataTransfer.files);if(!disabled&&!attachDisabled&&onDropFiles&&files.length){setFocused(true);onDropFiles(files);}}}>
  {hasAttachments&&<div className="jot-prompt-attachments" aria-label="待发送附件">{attachments}</div>}
  <textarea ref={textarea} className="jot-prompt-textarea" aria-label={ariaLabel} placeholder={placeholder} value={value} disabled={disabled||inputDisabled} maxLength={maxLength} rows={1}
   onChange={event=>onChange(event.target.value)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
   onKeyDown={event=>{if(isSubmitKey({key:event.key,shiftKey:event.shiftKey,keyCode:event.nativeEvent.keyCode,isComposing:composing.current||event.nativeEvent.isComposing})){event.preventDefault();send();}}}/>
  <div className="jot-prompt-toolbar">
   <div className="jot-prompt-settings" aria-hidden={!expanded} inert={!expanded}>
    {selection&&<div className="jot-prompt-model-anchor"><button ref={modelButton} className="jot-prompt-setting" type="button" aria-label={`选择模型，当前 ${model?.label??selection.model}`} aria-haspopup="menu" aria-expanded={menu==='model'} disabled={disabled||!modelOptions.length} onClick={()=>setMenu(current=>current==='model'?null:'model')}><Glyph kind="model"/><span>{model?.label??selection.model}</span></button>
     {menu==='model'&&<div className="jot-prompt-menu jot-composer-glass" role="menu" aria-label="模型" onKeyDown={menuKeys}>{modelOptions.map(option=><button key={`${option.provider}:${option.model}`} type="button" role="menuitemradio" aria-checked={option.provider===selection.provider&&option.model===selection.model} disabled={disabled||!onSelectionChange} onClick={()=>{onSelectionChange?.(modelSelection(option));closeMenu(true);}}><Glyph kind="model"/><span>{option.label??option.model}</span><small>{option.provider}</small></button>)}</div>}
    </div>}
    {effort&&<button className="jot-prompt-setting jot-prompt-effort" type="button" aria-label={`推理强度：${effort}`} title={onSelectionChange?'循环切换模型支持的推理强度':'当前模型设置为只读'} disabled={disabled||!onSelectionChange||(model?.supported_reasoning_efforts.length??0)<2} onClick={()=>{const next=nextEffort(modelOptions,selection);if(selection&&next)onSelectionChange?.({...selection,reasoning_effort:next});}}><Glyph kind="effort"/><span>{effort}</span></button>}
   </div>
   <div className="jot-prompt-actions">
    {(onAttach||moreMenu)&&<div className="jot-prompt-more-anchor" aria-hidden={!expanded} inert={!expanded}><button ref={plusButton} className="jot-prompt-plus" type="button" aria-label={moreMenu?'更多消息选项':'添加文件'} aria-haspopup={moreMenu?'menu':undefined} aria-expanded={moreMenu?menu==='more':undefined} disabled={disabled||(!moreMenu&&attachDisabled)} onClick={()=>{if(moreMenu)setMenu(current=>current==='more'?null:'more');else onAttach?.();}}><Glyph kind="plus"/></button>
     {menu==='more'&&<div className="jot-prompt-menu jot-prompt-more-menu jot-composer-glass" role="menu" aria-label="更多消息选项" onKeyDown={menuKeys} onClick={event=>{if((event.target as Element).closest('button'))closeMenu(true);}}>{onAttach&&<button type="button" role="menuitem" disabled={disabled||attachDisabled} onClick={()=>{onAttach();closeMenu(true);}}>添加文件</button>}{uploadMenu}{goalMenu}{onGoalMode&&<button type="button" role="menuitem" onClick={()=>{onGoalMode();closeMenu(true);}}>目标模式</button>}</div>}
    </div>}
    {(voiceActive||(!responding&&(keepVoiceVisible||(!value.trim()&&!hasAttachments))))&&voiceControl&&<div className="jot-prompt-voice">{voiceControl}</div>}
    {responding&&onStop&&<button className="jot-prompt-primary" type="button" aria-label="停止生成" title="停止生成" disabled={stopDisabled} onClick={onStop}><Glyph kind="stop"/></button>}
    {(!voiceActive&&(Boolean(value.trim()||hasAttachments)||(!voiceControl&&!responding)))&&<button className="jot-prompt-primary" type="button" aria-label={submitLabel} title={submitLabel} disabled={!canSend} onClick={send}><Glyph kind="send"/></button>}
   </div>
  </div>
  {dragging&&<div className="jot-prompt-drop-hint" role="status">松开以添加文件</div>}
 </div>;
}
