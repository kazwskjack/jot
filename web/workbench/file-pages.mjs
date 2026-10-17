export function createFilePager(load){
 let state={items:[],next_cursor:null,error:'',loading:false},generation=0,controller=null;
 const listeners=new Set(),publish=patch=>{state={...state,...patch};for(const listener of listeners)listener();};
 const read=async(cursor)=>{
  const current=++generation;controller?.abort();const request=new AbortController();controller=request;
  publish({loading:true,error:''});
  try{
   const page=await load(cursor,request.signal);if(request.signal.aborted||current!==generation)return;
   const prior=new Set(state.items.map(item=>item.path));
   if(!Array.isArray(page.items)||page.items.some(item=>prior.has(item.path)||!prior.add(item.path))||page.next_cursor===cursor&&cursor!==undefined)throw Error('文件列表响应冲突，请刷新后重试。');
   publish({items:[...state.items,...page.items],next_cursor:page.next_cursor??null});
  }catch(error){
   if(request.signal.aborted||current!==generation)return;
   const message=error instanceof Error?error.message:'文件列表读取失败';
   if(/FILE_LIST_STATE_CONFLICT|INVALID_FILE_LIST_CURSOR|文件列表响应冲突/.test(message))publish({items:[],next_cursor:null,error:'文件列表已变化或分页已失效，请刷新后重新加载。'});
   else publish({error:message});
  }finally{if(!request.signal.aborted&&current===generation)publish({loading:false});}
 };
 return {getSnapshot:()=>state,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
  refresh:()=>{publish({items:[],next_cursor:null,error:''});return read(undefined);},
  more:()=>!state.loading&&state.next_cursor?read(state.next_cursor):Promise.resolve(),
  dispose:()=>{generation++;controller?.abort();publish({items:[],next_cursor:null,error:'',loading:false});}};
}
