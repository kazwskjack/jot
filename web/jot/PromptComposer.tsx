import {useApplicationLanguage,useApplicationText} from './application-language';
import {useMessageDisplayPreferences} from './useToolDisplayPreference';
import type {ModelCompatibility} from './types';
import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {isComposerExpanded,isSubmitKey,modelSelection,nextEffort,selectedModel,selectedEffort,modelCapabilitySummary} from './prompt-composer-policy.mjs';
import {collectDroppedFiles} from './upload-directory.mjs';

export type PromptHealth={status:'healthy'|'unhealthy'|'stale'|'unknown';observed_at:number|null;expires_at:number|null};
export type PromptSelection={provider:string;model:string;reasoning_effort?:string;fallbacks?:Array<{provider:string;model:string}>};
export type PromptModelOption={provider:string;model:string;label?:string;supported_reasoning_efforts:string[];health?:PromptHealth;compatibility?:ModelCompatibility};
export type PromptComposerProps={
 value:string;onChange:(value:string)=>void;onSubmit:()=>void;
 attachments?:React.ReactNode;hasAttachments?:boolean;onAttach?:()=>void;onDropFiles?:(files:File[],relativePaths?:string[])=>void;onDropError?:(error:unknown)=>void;
 voiceControl?:React.ReactNode;voiceActive?:boolean;keepVoiceVisible?:boolean;
 responding?:boolean;onStop?:()=>void;disabled?:boolean;inputDisabled?:boolean;submitDisabled?:boolean;attachDisabled?:boolean;stopDisabled?:boolean;
 modelOptions?:PromptModelOption[];selection?:PromptSelection;onSelectionChange?:(selection:PromptSelection)=>void;
 goalMenu?:React.ReactNode;uploadMenu?:React.ReactNode;onGoalMode?:()=>void;
 placeholder?:string;ariaLabel?:string;maxLength?:number;submitLabel?:string;className?:string;onOpenChange?:(open:boolean)=>void;
};

function Glyph({kind}:{kind:'send'|'stop'|'model'|'effort'|'plus'}){
 return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{kind==='send'?<path d="M12 19V5m-6 6 6-6 6 6"/>:kind==='stop'?<rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>:kind==='model'?<><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></>:kind==='effort'?<><path d="M5 18v-4m7 4V9m7 9V5"/></>:<path d="M12 5v14M5 12h14"/>}</svg>;
}

const healthLabel=(option:PromptModelOption|undefined,language='zh-CN')=>{const labels=language==='en'?{healthy:'Healthy',unhealthy:'Unhealthy',stale:'Stale',unknown:'Unknown'}:{healthy:'健康',unhealthy:'异常',stale:'过期',unknown:'未知'},status=option?.health?.status??'unknown';return Object.hasOwn(labels,status)?labels[status]:labels.unknown;};
const isRoute=(route:{provider:string;model:string},option:PromptModelOption)=>route.provider===option.provider&&route.model===option.model;

function ModelMenuLabel({option}:{option:PromptModelOption}){
 const language=useApplicationLanguage();
 return <span className="jot-prompt-model-text"><span>{option.label??option.model}</span><small>{option.provider} · {healthLabel(option,language)}</small><small>{modelCapabilitySummary(option,language)}</small></span>;
}

/** Independent implementation from the public preview; material belongs to the host. */
export default function PromptComposer({value,onChange,onSubmit,attachments,hasAttachments=false,onAttach,onDropFiles,onDropError,voiceControl,voiceActive=false,keepVoiceVisible=false,responding=false,onStop,disabled=false,inputDisabled=false,submitDisabled=false,attachDisabled=false,stopDisabled=disabled,modelOptions=[],selection,onSelectionChange,goalMenu,uploadMenu,onGoalMode,placeholder,ariaLabel,maxLength=8000,submitLabel,className='',onOpenChange}:PromptComposerProps){
 const language=useApplicationLanguage(),t=useApplicationText();
 const {value:displayPreferences}=useMessageDisplayPreferences();
 const root=useRef<HTMLDivElement>(null),textarea=useRef<HTMLTextAreaElement>(null),modelButton=useRef<HTMLButtonElement>(null),fallbackButton=useRef<HTMLButtonElement>(null),plusButton=useRef<HTMLButtonElement>(null),composing=useRef(false),dragDepth=useRef(0);
 const [focused,setFocused]=useState(false),[menu,setMenu]=useState<'model'|'fallback'|'more'|null>(null),[dragging,setDragging]=useState(false);
 const expanded=isComposerExpanded({focused,value,hasAttachments,voiceActive,menu});
 const model=selectedModel(modelOptions,selection) as PromptModelOption|undefined;
 const effort=selectedEffort(modelOptions,selection);
 const fallbacks=selection?.fallbacks??[];
 const canSend=!disabled&&!submitDisabled&&!voiceActive&&Boolean(value.trim()||hasAttachments);
 const moreMenu=Boolean(goalMenu||uploadMenu||onGoalMode);
 useEffect(()=>{onOpenChange?.(expanded);},[expanded,onOpenChange]);
 useEffect(()=>{
  const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target)){setMenu(null);setFocused(false);}};
  document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
 },[]);
 useEffect(()=>{if(disabled){setMenu(null);setDragging(false);dragDepth.current=0;}},[disabled]);
 useLayoutEffect(()=>{const input=textarea.current;if(!input)return;input.style.height='0px';const height=expanded?Math.min(176,Math.max(40,input.scrollHeight)):24;input.style.height=`${height}px`;input.style.overflowY=input.scrollHeight>176?'auto':'hidden';},[value,expanded]);
 useLayoutEffect(()=>{if(!menu)return;root.current?.querySelector<HTMLButtonElement>('.jot-prompt-menu[role=menu] button:not(:disabled)')?.focus();},[menu]);
 const send=()=>{if(canSend)onSubmit();};
 const closeMenu=(restoreFocus=false)=>{if(restoreFocus)(menu==='model'?modelButton:menu==='fallback'?fallbackButton:plusButton).current?.focus();setMenu(null);};
 const toggleFallback=(option:PromptModelOption)=>{
  if(!selection||!onSelectionChange)return;
  const exists=fallbacks.some(route=>isRoute(route,option));
  const next=exists?fallbacks.filter(route=>!isRoute(route,option)):[...fallbacks,{provider:option.provider,model:option.model}];
  onSelectionChange({...selection,...(next.length?{fallbacks:next}:{fallbacks:undefined})});
 };
 const menuKeys=(event:React.KeyboardEvent<HTMLDivElement>)=>{
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  if(!buttons.length)return;event.preventDefault();const current=buttons.indexOf(document.activeElement as HTMLButtonElement);
  const index=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?(current+1)%buttons.length:(current-1+buttons.length)%buttons.length;buttons[index]?.focus();
 };
 return <div ref={root} lang={language} className={`jot-prompt-composer jot-composer-glass ${className}`} data-expanded={expanded} data-voice-active={voiceActive||undefined} data-dragging={dragging||undefined} aria-label={t('消息输入区','Message composer')} role="group"
  onFocusCapture={event=>{if((event.target as Element)===textarea.current||expanded)setFocused(true);}} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null)){setFocused(false);setMenu(null);}}}
  onKeyDown={event=>{if(event.key!=='Escape')return;if(menu){event.preventDefault();event.stopPropagation();closeMenu(true);}else if(!value.trim()&&!hasAttachments&&!voiceActive&&document.activeElement===textarea.current){event.preventDefault();event.stopPropagation();textarea.current?.blur();setFocused(false);}}}
  onDragEnter={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth.current++;if(!disabled&&!attachDisabled&&onDropFiles)setDragging(true);}}}
  onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=!disabled&&!attachDisabled&&onDropFiles?'copy':'none';}}}
  onDragLeave={()=>{dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setDragging(false);}}
  onDrop={event=>{event.preventDefault();dragDepth.current=0;setDragging(false);const items=Array.from(event.dataTransfer.items),dropItems=items.length?items:Array.from(event.dataTransfer.files);if(!disabled&&!attachDisabled&&onDropFiles&&dropItems.length){setFocused(true);void collectDroppedFiles(dropItems).then(dropped=>{const files=dropped.map(item=>item.file),relativePaths=dropped.map(item=>item.relativePath);if(files.length)onDropFiles(files,relativePaths);}).catch(error=>onDropError?.(error));}}}>
  {hasAttachments&&<div className="jot-prompt-attachments" lang="zh-CN" aria-label="待发送附件">{attachments}</div>}
  <textarea ref={textarea} className="jot-prompt-textarea" aria-label={ariaLabel??t('消息','Message')} placeholder={placeholder??t('输入消息…','Type a message…')} value={value} disabled={disabled||inputDisabled} maxLength={maxLength} rows={1} aria-keyshortcuts={displayPreferences.sendByCtrlEnter?'Control+Enter Meta+Enter':'Enter Control+Enter Meta+Enter'}
   onChange={event=>onChange(event.target.value)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
   onKeyDown={event=>{if(!event.defaultPrevented&&isSubmitKey({key:event.key,shiftKey:event.shiftKey,ctrlKey:event.ctrlKey,metaKey:event.metaKey,keyCode:event.nativeEvent.keyCode,isComposing:composing.current||event.nativeEvent.isComposing},displayPreferences.sendByCtrlEnter)){event.preventDefault();send();}}}/>
  <div className="jot-prompt-toolbar">
   <div className="jot-prompt-settings" aria-hidden={!expanded} inert={!expanded}>
    {selection&&<div className="jot-prompt-model-anchor"><button ref={modelButton} className="jot-prompt-setting" type="button" aria-label={t(`选择模型，当前 ${model?.label??selection.model}，健康状态${healthLabel(model,language)}`,`Select model, current ${model?.label??selection.model}, health ${healthLabel(model,language)}`)} aria-haspopup="menu" aria-expanded={menu==='model'} disabled={disabled||!modelOptions.length} onClick={()=>setMenu(current=>current==='model'?null:'model')}><Glyph kind="model"/><span>{model?.label??selection.model}</span></button>
     {menu==='model'&&<div className="jot-prompt-menu jot-composer-glass" role="menu" aria-label={t('模型','Models')} onKeyDown={menuKeys}>{modelOptions.map(option=><button key={`${option.provider}:${option.model}`} type="button" role="menuitemradio" aria-checked={option.provider===selection.provider&&option.model===selection.model} disabled={disabled||!onSelectionChange} onClick={()=>{onSelectionChange?.(modelSelection(option));closeMenu(true);}}><Glyph kind="model"/><ModelMenuLabel option={option}/></button>)}</div>}
    </div>}
    {selection&&<div className="jot-prompt-model-anchor"><button ref={fallbackButton} className="jot-prompt-setting jot-prompt-fallback" type="button" aria-label={t(`备选模型：${fallbacks.length}`,`Fallback models: ${fallbacks.length}`)} aria-haspopup="menu" aria-expanded={menu==='fallback'} disabled={disabled||!onSelectionChange} onClick={()=>setMenu(current=>current==='fallback'?null:'fallback')}>{t('备选','Fallbacks')} · {fallbacks.length}</button>
     {menu==='fallback'&&<div className="jot-prompt-menu jot-composer-glass" role="menu" aria-label={t('备选模型','Fallback Models')} onKeyDown={menuKeys}>{fallbacks.filter(route=>!modelOptions.some(option=>isRoute(route,option))).map(route=><button key={`${route.provider}:${route.model}`} type="button" role="menuitemcheckbox" aria-checked="true" disabled={disabled||!onSelectionChange} onClick={()=>onSelectionChange?.({...selection,fallbacks:fallbacks.filter(candidate=>candidate!==route)})}><Glyph kind="model"/><span>{route.model}</span><small>{route.provider} · {t('未知','Unknown')}</small></button>)}{modelOptions.filter(option=>!isRoute({provider:selection.provider,model:selection.model},option)).map(option=>{const checked=fallbacks.some(route=>isRoute(route,option)),compatible=Boolean(selection.reasoning_effort)&&option.supported_reasoning_efforts.includes(selection.reasoning_effort!);return <button key={`${option.provider}:${option.model}`} type="button" role="menuitemcheckbox" aria-checked={checked} disabled={disabled||!onSelectionChange||(!checked&&(fallbacks.length>=3||!compatible))} onClick={()=>toggleFallback(option)}><Glyph kind="model"/><ModelMenuLabel option={option}/></button>;})}{!selection.reasoning_effort&&<p className="jot-prompt-menu-note">{t('请先设置明确的推理强度，再添加备选模型。','Choose an explicit reasoning effort before adding fallback models.')}</p>}{fallbacks.length>=3&&<p className="jot-prompt-menu-note">{t('最多可选 3 个备选模型。','Choose at most 3 fallback models.')}</p>}</div>}
    </div>}
    {Boolean(effort||model?.supported_reasoning_efforts.length)&&<button className="jot-prompt-setting jot-prompt-effort" type="button" aria-label={t(`推理强度：${effort??'默认'}`,`Reasoning effort: ${effort??'Default'}`)} title={onSelectionChange?t('循环切换模型支持的推理强度','Cycle through the model’s supported reasoning efforts'):t('当前模型设置为只读','Current model settings are read-only')} disabled={disabled||!onSelectionChange||(Boolean(effort)&&(model?.supported_reasoning_efforts.length??0)<2)} onClick={()=>{const next=nextEffort(modelOptions,selection);if(selection&&next)onSelectionChange?.({...selection,reasoning_effort:next});}}><Glyph kind="effort"/><span>{effort??t('默认','Default')}</span></button>}
   </div>
   <div className="jot-prompt-actions">
    {(onAttach||moreMenu)&&<div className="jot-prompt-more-anchor" aria-hidden={!expanded} inert={!expanded}><button ref={plusButton} className="jot-prompt-plus" type="button" aria-label={moreMenu?t('更多消息选项','More Message Options'):t('添加文件','Attach Files')} aria-haspopup={moreMenu?'menu':undefined} aria-expanded={moreMenu?menu==='more':undefined} disabled={disabled||(!moreMenu&&attachDisabled)} onClick={()=>{if(moreMenu)setMenu(current=>current==='more'?null:'more');else onAttach?.();}}><Glyph kind="plus"/></button>
     {menu==='more'&&<div className="jot-prompt-menu jot-prompt-more-menu jot-composer-glass" role="menu" aria-label={t('更多消息选项','More Message Options')} onKeyDown={menuKeys} onClick={event=>{if((event.target as Element).closest('button'))closeMenu(true);}}>{onAttach&&<button type="button" role="menuitem" disabled={disabled||attachDisabled} onClick={()=>{onAttach();closeMenu(true);}}>{t('添加文件','Attach Files')}</button>}{uploadMenu}{goalMenu}{onGoalMode&&<button type="button" role="menuitem" onClick={()=>{onGoalMode();closeMenu(true);}}>{t('目标模式','Goal Mode')}</button>}</div>}
    </div>}
    {(voiceActive||(!responding&&(keepVoiceVisible||(!value.trim()&&!hasAttachments))))&&voiceControl&&<div className="jot-prompt-voice" lang="zh-CN">{voiceControl}</div>}
    {responding&&onStop&&<button className="jot-prompt-primary" type="button" aria-label={t('停止生成','Stop Generation')} title={t('停止生成','Stop Generation')} disabled={stopDisabled} onClick={onStop}><Glyph kind="stop"/></button>}
    {(!voiceActive&&(Boolean(value.trim()||hasAttachments)||(!voiceControl&&!responding)))&&<button className="jot-prompt-primary" type="button" aria-label={submitLabel??t('发送','Send')} title={submitLabel??t('发送','Send')} disabled={!canSend} onClick={send}><Glyph kind="send"/></button>}
   </div>
  </div>
  {dragging&&<div className="jot-prompt-drop-hint" role="status">{t('松开以添加文件','Drop to Attach Files')}</div>}
 </div>;
}
