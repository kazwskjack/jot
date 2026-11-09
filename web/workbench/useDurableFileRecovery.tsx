import {useEffect,useState} from 'react';
import {DurableFileRecoveryStore} from './durable-file-recovery.mjs';

export function useDurableFileRecovery(namespace:string,createStore:(storage:Storage)=>any,enabled=true){
 const [revision,setRevision]=useState(0);
 const identity=JSON.stringify([namespace,revision,enabled]);
 const [state,setState]=useState<{identity:string;store:DurableFileRecoveryStore|null;loading:boolean;error:string}>({identity:'',store:null,loading:true,error:''});
 useEffect(()=>{
  if(!enabled){setState({identity,store:null,loading:false,error:''});return;}
  let alive=true,opened:DurableFileRecoveryStore|null=null;
  setState({identity,store:null,loading:true,error:''});
  void (async()=>{
   const store=await DurableFileRecoveryStore.open(window.indexedDB,namespace,createStore,window.sessionStorage);
   if(!alive){store.close();return;}
   opened=store;setState({identity,store,loading:false,error:''});
  })().catch(()=>{if(alive)setState({identity,store:null,loading:false,error:'文件操作持久回执尚未读取，请重读原请求。'});});
  return()=>{alive=false;opened?.close();};
 },[identity,namespace,createStore,enabled]);
 const current=state.identity===identity?state:null;
 return {
  key:identity+':'+!!current?.store,
  store:current?.store??null,
  loading:enabled&&(current?.loading??true),
  error:current?.error??'',
  reload:()=>setRevision(value=>value+1),
 };
}
