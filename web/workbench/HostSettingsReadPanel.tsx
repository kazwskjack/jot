import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import React,{useEffect,useRef,useState} from 'react';
import type {HostAdminClient,HostNamespaceSettingsSnapshot} from './types';

type Snapshot=HostNamespaceSettingsSnapshot['namespaces'][number];
type ReadState={generation:number;approved:string[]|null;snapshots:Record<string,Snapshot>;connecting:boolean;loading:string|null;error:string};
const emptyReadState=(generation:number):ReadState=>({generation,approved:null,snapshots:{},connecting:false,loading:null,error:''});
const safeNamespaces=(value:unknown):string[]=>Array.isArray(value)?[...new Set(value.filter((item):item is string=>typeof item==='string'&&/^[a-z][a-z0-9._-]{0,127}$/.test(item)&&item!=='jot-host-policy'))]:[];
function failureCode(error:unknown){
 const message=error!==null&&typeof error==='object'&&'message'in error?(error as {message?:unknown}).message:undefined;
 return typeof message==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(message)?message:'HOST_SETTINGS_UNAVAILABLE';
}

export default function HostSettingsReadPanel({enabled,namespaces,client,scopeKey=''}:{enabled:boolean;namespaces:unknown;client:HostAdminClient;scopeKey?:string}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const configured=safeNamespaces(namespaces);
 const namespaceIdentity=configured.join('\u0000');
 const context=useRef({enabled,client,namespaceIdentity,scopeKey,generation:0});
 const previous=context.current;
 if(previous.enabled!==enabled||previous.client!==client||previous.namespaceIdentity!==namespaceIdentity||previous.scopeKey!==scopeKey)
  context.current={enabled,client,namespaceIdentity,scopeKey,generation:previous.generation+1};
 const renderContext=context.current;
 const requestSequence=useRef(0);
 const [stored,setStored]=useState<ReadState>(()=>emptyReadState(renderContext.generation));
 const state=stored.generation===renderContext.generation?stored:emptyReadState(renderContext.generation);
 useEffect(()=>{setStored(emptyReadState(renderContext.generation));},[renderContext.generation]);
 const begin=()=>renderContext===context.current?{generation:renderContext.generation,sequence:++requestSequence.current}:null;
 const current=(operation:{generation:number;sequence:number})=>context.current===renderContext&&operation.generation===renderContext.generation&&requestSequence.current===operation.sequence;
 const update=(operation:{generation:number;sequence:number},patch:Partial<ReadState>)=>setStored(previous=>current(operation)?{...(previous.generation===operation.generation?previous:emptyReadState(operation.generation)),...patch}:previous);
 if(!enabled)return null;
 const approve=async()=>{
  const operation=begin();if(!operation)return;
  update(operation,{connecting:true,error:'',snapshots:{}});
  try{
   const result=await client.approveSettingsRead();
   const allowed=safeNamespaces(result?.namespaces).filter(namespace=>configured.includes(namespace));
   if(result?.approved!==true||allowed.length===0)throw new Error('HOST_BOOTSTRAP_INVALID');
   update(operation,{approved:allowed});
  }catch(reason){update(operation,{approved:null,error:failureCode(reason)});}
  finally{update(operation,{connecting:false});}
 };
 const read=async(namespace:string)=>{
  if(!state.approved?.includes(namespace))return;
  const operation=begin();if(!operation)return;
  update(operation,{loading:namespace,error:''});
  try{
   const response=await client.namespaceSettings(namespace),item=response?.namespaces?.length===1?response.namespaces[0]:undefined;
   if(response?.protocol!==1||response.source!=='dsh-settings-controller'||item?.namespace!==namespace)throw new Error('HOST_SETTINGS_INVALID');
   update(operation,{snapshots:{...state.snapshots,[namespace]:item}});
  }catch(reason){update(operation,{error:failureCode(reason)});}
  finally{update(operation,{loading:null});}
 };
 return <section lang={language} className="wb-form" aria-labelledby="wb-host-settings-read">
  <h3 id="wb-host-settings-read">{t("Host 只读设置","Host Read-only Settings")}</h3>
  <p className="wb-status">{t("仅读取获批 namespace。授权会在 DSH owner 确认页显示 actor、Gateway、Host、操作范围和期限；只有 owner 明确批准后才能读取。","Only approved namespaces are read. The DSH owner confirmation page shows the actor, Gateway, Host, operation scope and expiry; reading requires explicit owner approval.")}</p>
  {!state.approved?<button type="button" className="wb-primary" disabled={state.connecting||configured.length===0} onClick={()=>void approve()}>{state.connecting?t('等待 DSH owner 批准…','Waiting for DSH owner approval…'):t('批准并连接 Host','Approve and Connect to Host')}</button>:<>
   <p className="wb-status">{t(`已批准 ${state.approved.length} 个 namespace；授权由 Host 限期保存。设置值由 Host 脱敏后返回。`,`${state.approved.length} namespaces approved; the Host retains authorization for a limited time. Settings values are returned after Host redaction.`)}</p>
   <ul className="wb-settings-list">{state.approved.map(namespace=><li key={namespace}>
    <strong>{namespace}</strong><button type="button" disabled={state.loading!==null} onClick={()=>void read(namespace)}>{state.loading===namespace?t('正在读取…','Reading…'):t('读取','Read')}</button>
   </li>)}</ul>
   {state.approved.map(namespace=>{const item=state.snapshots[namespace];if(!item)return null;return <details key={`snapshot:${namespace}`} open>
    <summary>{namespace} · {item.state==='ready'?t('就绪','Ready'):item.state==='partial'?t('部分数据','Partial Data'):t('未知','Unknown')} · {t('修订','Revision')} {item.revision??t('未知','Unknown')}</summary>
    <p className="wb-status">{t('生效方式：','Applies: ')}{item.applies} · {t(`Host 报告 ${item.secrets.length} 个凭据字段状态，不返回凭据值。`,`The Host reports ${item.secrets.length} credential field states without returning credential values.`)}</p>
    <pre className="wb-host-settings-value" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:360,overflow:'auto'}}>{JSON.stringify(item.value,null,2)??t('未知（Host 未返回值）','Unknown (Host returned no value)')}</pre>
   </details>;})}
   <button type="button" disabled={state.connecting||state.loading!==null} onClick={()=>void approve()}>{state.connecting?t('等待 DSH owner 批准…','Waiting for DSH owner approval…'):t('重新批准','Approve Again')}</button>
  </>}
  {configured.length===0?<p className="wb-status">{t("未配置可读 namespace。","No readable namespace is configured.")}</p>:null}
  {state.error?<p className="wb-error" role="alert">{t(`Host 设置读取失败。（${state.error}）`,`Reading Host settings failed. (${state.error})`)}</p>:null}
 </section>;
}
