import {createContext,useContext,useEffect,useRef,useState} from 'react';
import {TaskSaveReceipt} from './task-save.mjs';
import {request} from '../jot/client';
export const MutationPending=createContext<(pending:boolean)=>void>(()=>{});
export const MutationPendingState=createContext(false);
/** Current-page recovery. Use the existing request receipt logic; never infer
 * rejection from response loss or silently replace the pending request. */
export function useMutationReceipt(){
 const receipt=useRef(new TaskSaveReceipt()),report=useContext(MutationPending),[,render]=useState(0);
 useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(receipt.current.pending){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>{window.removeEventListener('beforeunload',warn);report(false);};},[report]);
 return {pending:receipt.current.pending,submit:async(path:string,method:string,body:unknown)=>{
  const operation=receipt.current.submit(request,path,method,body);report(receipt.current.pending);render(n=>n+1);
  try{return await operation;}finally{report(receipt.current.pending);render(n=>n+1);}
 }};
}
