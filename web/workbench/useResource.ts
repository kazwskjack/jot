import {useCallback,useEffect,useRef,useState} from 'react';
export function useResource<T>(load:(signal:AbortSignal)=>Promise<T>,identity:string,enabled=true){
 const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
 const loader=useRef(load);loader.current=load;
 const reload=useCallback(()=>setRevision(value=>value+1),[]);
 useEffect(()=>{setData(null);},[identity,enabled]);
 useEffect(()=>{if(!enabled){setLoading(false);setError('');return;}const controller=new AbortController();setLoading(true);setError('');
  loader.current(controller.signal).then(value=>{if(!controller.signal.aborted)setData(value);}).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:'读取失败');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[identity,enabled,revision]);
 return {data,error,loading,reload};
}
