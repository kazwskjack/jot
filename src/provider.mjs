export function modelProvider({baseUrl,key,model}){
  return async (messages,tools,signal,onText=()=>{})=>{
    if(!baseUrl||!model)throw new Error('model_not_configured');
    const url=new URL(baseUrl.replace(/\/$/,'')+'/chat/completions');
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('invalid_model_url');
    const response=await fetch(url,{method:'POST',signal:AbortSignal.any([signal,AbortSignal.timeout(120000)]),headers:{'content-type':'application/json',...(key?{authorization:`Bearer ${key}`}:{})},body:JSON.stringify({model,messages,tools,stream:true})});
    if(!response.ok)throw new Error(`model_http_${response.status}`);
    if(!response.body)throw new Error('model_stream_missing');
    let buffer='',text='',ended=false;const calls=new Map(),decoder=new TextDecoder();
    for await(const bytes of response.body){
      buffer+=decoder.decode(bytes,{stream:true});if(buffer.length>2_000_000)throw new Error('model_frame_too_large');
      let boundary;
      while((boundary=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,boundary).trim();buffer=buffer.slice(boundary+1);if(!line.startsWith('data:'))continue;
        const data=line.slice(5).trim();if(data==='[DONE]'){ended=true;continue;}if(!data)continue;
        const value=JSON.parse(data);if(value.error)throw new Error('model_stream_error');const choice=value.choices?.[0],delta=choice?.delta??{};
        if(choice?.finish_reason==='length')throw new Error('model_output_truncated');
        if(choice?.finish_reason==='content_filter')throw new Error('model_content_filtered');
        if(choice?.finish_reason&&!['stop','tool_calls'].includes(choice.finish_reason))throw new Error('model_finish_reason_invalid');
        if(choice?.finish_reason)ended=true;
        if(delta.content){text+=delta.content;if(text.length>100000)throw new Error('model_output_too_large');onText(delta.content);}
        for(const c of delta.tool_calls??[]){const previous=calls.get(c.index)??{id:'',type:'function',function:{name:'',arguments:''}};previous.id+=c.id??'';previous.function.name+=c.function?.name??'';previous.function.arguments+=c.function?.arguments??'';if(previous.function.arguments.length>100000)throw new Error('model_tool_args_too_large');calls.set(c.index,previous);}
      }
    }
    if(!ended)throw new Error('model_stream_incomplete');
    for(const call of calls.values())if(!call.id||!call.function.name||!call.function.arguments)throw new Error('model_tool_call_invalid');
    return {role:'assistant',content:text||null,...(calls.size?{tool_calls:[...calls.values()]}:{})};
  };
}
