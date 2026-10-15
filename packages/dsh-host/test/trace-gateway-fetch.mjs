// Test-only status trace. Requests and responses still use the original fetch.
import {appendFileSync} from 'node:fs';
const path=process.env.JOT_ACCEPTANCE_FETCH_TRACE;
if(path){const original=globalThis.fetch;globalThis.fetch=async(...args)=>{
 const response=await original(...args);const url=new URL(typeof args[0]==='object'&&'url' in args[0]?args[0].url:String(args[0]));
 let error;try{if(!response.ok){const body=await response.clone().json();if(typeof body.error==='string'&&/^[a-zA-Z_]+$/.test(body.error))error=body.error;}}catch{}
 try{appendFileSync(path,JSON.stringify({path:url.pathname,status:response.status,...(error?{error}:{})})+'\n');}catch{}
 return response;
};}
