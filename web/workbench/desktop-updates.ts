// Adapts PilotDeck 783499ff desktopUpdates; AGPL-3.0. Native Jot receipts remain authoritative.
export const updatePhases=['available','downloading','downloaded','verified','staged','awaiting-activation','activating','active','cancelled','failed','unknown'] as const;
export type UpdatePhase=typeof updatePhases[number];
export type DesktopUpdateStatus={enabled:boolean;reason:string|null;phase:UpdatePhase|null;operationId:string|null;checking:boolean|null;actionPending:boolean|null;operationCommands:1|null;activeCommand:'download'|'activate'|null;cancelPending:boolean|null};
export type DesktopUpdateCheck={available:boolean;operationId:string|null;phase:UpdatePhase|null;version:string;sequence:string;channel:string;platform:string;arch:string};
export type DesktopUpdatesBridge={getUpdateStatus:()=>Promise<unknown>;checkForUpdate:()=>Promise<unknown>;onUpdateProgress?:(listener:(event:unknown)=>void)=>()=>void};
const row=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const code=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,127}$/.test(value);
const phase=(value:unknown):value is UpdatePhase=>typeof value==='string'&&(updatePhases as readonly string[]).includes(value);
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const keys=(value:Record<string,unknown>,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
export function desktopUpdatesBridge():DesktopUpdatesBridge|null{
 const bridge=(window as Window&{jotDesktop?:Partial<DesktopUpdatesBridge>}).jotDesktop;
 return typeof bridge?.getUpdateStatus==='function'&&typeof bridge.checkForUpdate==='function'?bridge as DesktopUpdatesBridge:null;
}
export function desktopUpdateStatus(value:unknown):DesktopUpdateStatus{
 const r=row(value);
 if(!r||!keys(r,['enabled','reason','phase','operationId','checking','actionPending','operationCommands','activeCommand','cancelPending'])||typeof r.enabled!=='boolean'||
  (r.enabled?r.reason!==null:!code(r.reason))||(r.phase!==null&&!phase(r.phase))||
  (r.operationId!==undefined&&r.operationId!==null&&!uuid(r.operationId))||
  (r.checking!==undefined&&typeof r.checking!=='boolean')||(r.actionPending!==undefined&&typeof r.actionPending!=='boolean')||
  (r.operationCommands!==undefined&&r.operationCommands!==1)||(r.activeCommand!==undefined&&r.activeCommand!==null&&r.activeCommand!=='download'&&r.activeCommand!=='activate')||
  (r.cancelPending!==undefined&&typeof r.cancelPending!=='boolean')||
  (r.operationCommands===1&&(typeof r.checking!=='boolean'||typeof r.actionPending!=='boolean'||r.activeCommand===undefined||typeof r.cancelPending!=='boolean'||
   r.actionPending!==(r.activeCommand!==null||r.cancelPending===true)||(r.checking===true&&r.actionPending===true))))throw Error('desktop_update_status_invalid');
 return {enabled:r.enabled,reason:r.reason as string|null,phase:r.phase as UpdatePhase|null,operationId:uuid(r.operationId)?r.operationId:null,
  checking:typeof r.checking==='boolean'?r.checking:null,actionPending:typeof r.actionPending==='boolean'?r.actionPending:null,operationCommands:r.operationCommands===1?1:null,
  activeCommand:r.activeCommand==='download'||r.activeCommand==='activate'?r.activeCommand:null,cancelPending:typeof r.cancelPending==='boolean'?r.cancelPending:null};
}
export function desktopUpdateCheck(value:unknown):DesktopUpdateCheck{
 const r=row(value);
 if(!r||!keys(r,['available','reason','operationId','phase','resumable','version','sequence','channel','platform','arch'])||typeof r.available!=='boolean'||
  !text(r.version)||typeof r.sequence!=='string'||!/^[1-9][0-9]{0,19}$/.test(r.sequence)||!text(r.channel)||!text(r.platform)||!text(r.arch)||
  (r.phase!==undefined&&!phase(r.phase))||(r.resumable!==undefined&&typeof r.resumable!=='boolean')||
  (r.available?(!uuid(r.operationId)||r.reason!==undefined):(r.reason!=='desktop_update_already_current'||r.operationId!==undefined)))throw Error('desktop_update_check_invalid');
 return {available:r.available,operationId:uuid(r.operationId)?r.operationId:null,phase:phase(r.phase)?r.phase:null,version:r.version,sequence:r.sequence,channel:r.channel,platform:r.platform,arch:r.arch};
}
export function desktopUpdateProgress(value:unknown):boolean{
 const r=row(value);return !!r&&keys(r,['operation_id','phase'])&&uuid(r.operation_id)&&phase(r.phase);
}
export const updatePhaseLabel:Record<UpdatePhase,string>={available:'有待处理的更新候选',downloading:'下载阶段',downloaded:'已取得下载回执',verified:'签名校验阶段',staged:'已暂存',
 'awaiting-activation':'等待手动激活',activating:'激活阶段',active:'已切换活动版本，启动确认由宿主处理',cancelled:'已取消',failed:'操作失败',unknown:'操作状态未知'};
export const canCheckDesktopUpdate=(status:DesktopUpdateStatus|null)=>status?.enabled===true&&status.checking===false&&status.actionPending===false;
