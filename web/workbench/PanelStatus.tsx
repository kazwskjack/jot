import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import React from 'react';

export function ResourceStatus({loading,error,onRetry,label}:{loading:boolean;error:string;onRetry:()=>void;label?:string}){
 const language=useApplicationLanguage(),text=useApplicationText();
 return <>{loading&&<p lang={language} className="wb-status" role="status">{label?text(`正在加载 ${label}…`,`Loading ${label}…`):text('正在读取…','Loading…')}</p>}{error&&<div className="wb-error" role="alert" lang={language}><span>{error==='读取失败'?text('读取失败','Unable to read the data.'):error}</span><button type="button" onClick={onRetry}>{label?text(`重新加载 ${label}`,`Reload ${label}`):text('重新读取','Retry')}</button></div>}</>;
}

export const PanelStatus=ResourceStatus;
export function Empty({children}:{children:React.ReactNode}){return <p className="wb-empty">{children}</p>;}
