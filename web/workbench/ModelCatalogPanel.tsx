import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {modelHealthAt,modelHealthLabel} from '../jot/model-routing-status.mjs';
import {modelCapabilitySummary} from '../jot/prompt-composer-policy.mjs';
import {useModelHealthClock} from '../jot/useModelHealthClock';
import type {Capabilities} from '../jot/types';

/** Display existing native observations; never treat model health as CLI authentication. */
export default function ModelCatalogPanel({models}:{models:Capabilities['models']}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const entries=(Array.isArray(models)?models:[]).filter(item=>!!item&&typeof item==='object'&&!Array.isArray(item));
 const now=useModelHealthClock(entries);
 const time=(value:number|null)=>{if(value===null)return t('未提供','Not Provided');const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString(language==='en'?'en':'zh-CN'):String(value);};
 return <section lang={language} className="wb-form" aria-labelledby="wb-settings-catalog">
  <h3 id="wb-settings-catalog">{t('模型目录','Model Catalog')}</h3>
  <p className="wb-status">{t('目录表示已发现的模型；调用健康来自已有原生调用的观测，有效期届满后显示为过期。','The catalog lists discovered models. Call health comes from existing native call observations and is shown as stale after expiry.')}</p>
  {entries.length?<ul className="wb-settings-list">{entries.map((item,index)=>{
   const provider=typeof item.provider==='string'?item.provider:t('未知提供方','Unknown Provider'),model=typeof item.model==='string'?item.model:t('未知模型','Unknown Model');
   const health=modelHealthAt(item.health,now);
   return <li key={`${provider}:${model}:${index}`}>
    <strong>{typeof item.label==='string'?item.label:model}</strong><span>{provider} · <code>{model}</code></span>
    <span role="status">{t('最近调用健康：','Recent Call Health: ')}{modelHealthLabel(health,language)}</span>
    <span>{t('观测时间：','Observed At: ')}{time(health.observed_at)}</span><span>{t('记录有效期：','Record Expires At: ')}{time(health.expires_at)}</span>
    <span>{modelCapabilitySummary(item,language)}</span>
   </li>;
  })}</ul>:<p className="wb-status">{t('目录未知或为空。','The catalog is unknown or empty.')}</p>}
  <p className="wb-settings-note">{t('凭据引用配置、模型调用健康和 CLI 登录状态分别确认。此处不发起模型调用、登录或主动连接检查，也不代表 RuntimeReadiness 已就绪。','Credential reference configuration, model call health and CLI login status are confirmed separately. This view does not initiate model calls, login or active connection checks, and does not establish RuntimeReadiness.')}</p>
 </section>;
}
