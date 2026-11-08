function previewError(error){
 const message=error instanceof Error?error.message:'';
 const code=message.toLowerCase();
 if(code==='invalid_cron_expression')return 'Cron 表达式无效，请检查五段表达式。';
 if(code==='invalid_timezone')return 'IANA 时区无效，请填写有效时区，例如 Asia/Hong_Kong。';
 if(code==='invalid_delay')return '延迟秒数无效，请填写 1–31536000 的整数秒。';
 return error instanceof Error?error.message:'执行时间预览暂不可用';
}
export function beginSchedulePreview(trigger,request,onState,delayMs=300) {
 const controller=new AbortController();
 let cancelled=false;
 onState({status:'loading'});
 const timer=setTimeout(async()=>{
  try{
   const result=await request('/persistent-tasks/preview','POST',{trigger},undefined,controller.signal);
   if(!cancelled)onState({status:'ready',result});
  }catch(error){
   if(!cancelled)onState({status:'error',message:previewError(error)});
  }
 },delayMs);
 return ()=>{cancelled=true;clearTimeout(timer);controller.abort();};
}
