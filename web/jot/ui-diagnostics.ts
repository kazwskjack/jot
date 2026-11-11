// Privacy-bounded UI diagnostics adapted from PilotDeck 783499ff ui/src/lib/uiDiagnostics.ts.
// Adapted portions retain AGPL-3.0; see packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt.
const slot='jot.ui-diagnostics.v1',limit=20;
const events=['react-boundary','window-error','unhandled-rejection','local-retry','manual-reload'] as const;
const kinds=['Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError','AggregateError','Unknown'] as const;
export type UiDiagnostic={at:string;event:typeof events[number];kind:typeof kinds[number];line:number;column:number};
const position=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=2147483647?value:0;
function valid(value:unknown):value is UiDiagnostic{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const item=value as UiDiagnostic;
 return Object.keys(item).sort().join(',')==='at,column,event,kind,line'&&typeof item.at==='string'&&item.at.length===24
  &&Number.isFinite(Date.parse(item.at))&&new Date(item.at).toISOString()===item.at
  &&events.includes(item.event)&&kinds.includes(item.kind)&&position(item.line)===item.line&&position(item.column)===item.column;
}
function readUiDiagnostics():UiDiagnostic[]{
 try{
  const raw=sessionStorage.getItem(slot);if(!raw||raw.length>8192)return [];
  const value:unknown=JSON.parse(raw);return Array.isArray(value)&&value.length<=limit&&value.every(valid)?value:[];
 }catch{return [];}
}
/** Only fixed event/error categories and numeric positions may cross this boundary. */
export function recordUiDiagnostic(event:UiDiagnostic['event'],error?:unknown,line?:unknown,column?:unknown):UiDiagnostic|undefined{
 try{
  if(!events.includes(event))return;
  let kind:UiDiagnostic['kind']='Unknown';
  try{const name=error instanceof Error?error.name:undefined;if(typeof name==='string'&&kinds.includes(name as UiDiagnostic['kind']))kind=name as UiDiagnostic['kind'];}catch{}
  const item:UiDiagnostic={at:new Date().toISOString(),event,kind,line:position(line),column:position(column)};
  try{sessionStorage.setItem(slot,JSON.stringify([...readUiDiagnostics().slice(-(limit-1)),item]));}catch{}
  return item;
 }catch{return;}
}
export function registerUiDiagnostics(){
 const onError=(event:ErrorEvent)=>{recordUiDiagnostic('window-error',event.error,event.lineno,event.colno);};
 const onRejection=(event:PromiseRejectionEvent)=>{recordUiDiagnostic('unhandled-rejection',event.reason);};
 window.addEventListener('error',onError);window.addEventListener('unhandledrejection',onRejection);
 return()=>{window.removeEventListener('error',onError);window.removeEventListener('unhandledrejection',onRejection);};
}
