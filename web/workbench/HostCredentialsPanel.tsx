import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import React from 'react';
import type {HostAdminClient} from './types';
import {useResource} from './useResource';

export default function HostCredentialsPanel({client,scopeKey}:{client:HostAdminClient;scopeKey:string}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const resource=useResource(signal=>client.credentials!(signal),scopeKey,typeof client.credentials==='function');
 if(!client.credentials||resource.data?.enabled===false)return null;
 return <section lang={language} aria-label={t('Host 凭据引用','Host Credential References')}><h3>{t("凭据引用","Credential References")}</h3>
  {resource.loading&&<p role="status">{t("正在读取凭据管理入口…","Reading credential management entry…")}</p>}
  {resource.error&&<p role="alert">{t("凭据管理入口暂不可用。","The credential management entry is unavailable.")}<button type="button" onClick={resource.reload}>{t("重新读取","Read Again")}</button></p>}
  {resource.data?.enabled&&resource.data.owner_url&&<>
   <p>{t("在原生 Host 中查看引用配置、轮换凭据和撤销存储值。可单独刷新配置状态并保留原操作结果；环境变量仍提供同名值时，撤销存储值后仍可能显示已配置。","View reference configuration, rotate credentials and revoke stored values in the native Host. Refresh configuration separately while retaining the original operation result; if an environment variable still supplies the value, the reference may remain configured after stored-value revocation.")}</p>
   <a href={resource.data.owner_url} target="_blank" rel="noopener noreferrer">{t("打开 Host 凭据管理","Open Host Credential Management")}</a>
  </>}
 </section>;
}
