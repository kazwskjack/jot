import React from 'react';

export function ResourceStatus({loading,error,onRetry,label}:{loading:boolean;error:string;onRetry:()=>void;label?:string}){
 return <>{loading&&<p className="wb-status" role="status">{label?`正在加载 ${label}…`:'正在读取…'}</p>}{error&&<div className="wb-error" role="alert"><span>{error}</span><button type="button" onClick={onRetry}>{label?`重新加载 ${label}`:'重新读取'}</button></div>}</>;
}

export const PanelStatus=ResourceStatus;
export function Empty({children}:{children:React.ReactNode}){return <p className="wb-empty">{children}</p>;}
