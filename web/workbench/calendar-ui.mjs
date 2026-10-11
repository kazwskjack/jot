export function beginSchedulePreview(trigger,request,onState,delayMs=300) {
 const controller=new AbortController();
 let cancelled=false;
 onState({status:'loading'});
 const timer=setTimeout(async()=>{
  try{
   const result=await request('/persistent-tasks/preview','POST',{trigger},undefined,controller.signal);
   if(!cancelled)onState({status:'ready',result});
  }catch(error){
   if(!cancelled)onState({status:'error',message:error instanceof Error?error.message:'执行时间预览暂不可用'});
  }
 },delayMs);
 return ()=>{cancelled=true;clearTimeout(timer);controller.abort();};
}
