import {createContext,useContext,useEffect,useRef,useState} from 'react';
import {TaskSaveReceipt} from './task-save.mjs';
import {request} from '../jot/client';
export const MutationPending=createContext<(pending:boolean)=>void>(()=>{});
export const MutationPendingState=createContext(false);
/** Current-page recovery. Use the existing request receipt logic; never infer
 * rejection from response loss or silently replace the pending request. */
export function useMutationReceipt(store?:any,key?:()=>string){
 const receipt=useRef<TaskSaveReceipt|null>(null),alive=useRef(true),report=useContext(MutationPending),[,render]=useState(0);
 if(!receipt.current)receipt.current=new TaskSaveReceipt(key,store??null);const current=receipt.current;
 useEffect(()=>{alive.current=true;if(current.pending)report(true);const warn=(event:BeforeUnloadEvent)=>{if(current.pending){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>{alive.current=false;window.removeEventListener('beforeunload',warn);report(false);};},[report,current]);
 return {pending:current.pending,submit:async(path:string,method:string,body:unknown)=>{
  const operation=current.submit(request,path,method,body);report(current.pending);render(n=>n+1);
  try{return await operation;}finally{if(alive.current){report(current.pending);render(n=>n+1);}}
 }};
}
