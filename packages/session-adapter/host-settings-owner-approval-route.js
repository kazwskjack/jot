import {randomBytes} from 'node:crypto';
import {createHostSettingsOwnerApproval,hostSettingsOwnerReviewDigest} from './host-settings-write-approval.js';

const PATH='/api/jot-host-settings/approval',TOKEN=/^[A-Za-z0-9_-]{43}$/;
const headers=()=>({'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});
const deny=(status,reason)=>Response.json({status:'held',reason_code:reason},{status,headers:headers()});
const escapeJson=v=>JSON.stringify(v).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');

/** Host owner producer, using the original Connection admission seam. The BFF
 * can prepare an exact review but cannot supply the peer or approve it. */
export function createHostSettingsOwnerApprovalProducer({connection,dshOrigin,jotOrigin,source,now=()=>Date.now()}={}){
 if(typeof connection?.admit!=='function'||typeof source?.readReview!=='function'||typeof source?.reconcile!=='function'
  ||new URL(dshOrigin).origin!==dshOrigin||jotOrigin!==undefined&&new URL(jotOrigin).origin!==jotOrigin)throw TypeError('host_settings_owner_route_invalid');
 const authority=createHostSettingsOwnerApproval({readCurrentReview:request=>source.readReview(request),now});
 const requests=new Map(),approvedWrites=new Map();
 const purge=()=>{for(const map of [requests,approvedWrites])for(const[k,v]of map)if(v.expires_at<=now())map.delete(k);};
 function peerFor(request){
  const url=new URL(request.url),origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
  if(url.origin!==dshOrigin||url.pathname!==PATH||request.headers.has('x-user-id')||site==='cross-site'
   ||origin!==null&&origin!==dshOrigin||request.method==='POST'&&(origin!==dshOrigin||site!=='same-origin'||url.search))return undefined;
  const admissionHeaders=Object.fromEntries(request.headers.entries());
  if(!admissionHeaders.host)admissionHeaders.host=url.host;
  const admitted=connection.admit({method:request.method,url:url.pathname+url.search,headers:admissionHeaders});
  return admitted&&!('rejection'in admitted)&&admitted.peer?.principal?.kind==='owner'?admitted.peer:undefined;
 }
 async function prepare(request){
  purge();const prepared=await authority.prepare(request);
  requests.set(prepared.challenge_id,{request:structuredClone(request),expires_at:prepared.expires_at});
  return{...prepared,owner_approval_url:`${dshOrigin}${PATH}?challenge_id=${encodeURIComponent(prepared.challenge_id)}`};
 }
 const ownerRoute={path:PATH,methods:['GET','POST'],requestBody:'buffered',async fetch(request){
  purge();let peer;try{peer=peerFor(request);}catch{}
  if(!peer)return deny(403,'host_settings_owner_required');
  if(request.method==='GET'){
   const query=new URL(request.url).searchParams,id=query.get('challenge_id');
   if(query.size!==1||!TOKEN.test(id??'')||!requests.has(id))return deny(422,'host_settings_approval_invalid');
   let page;try{page=authority.open({peer,challenge_id:id});}catch{return deny(409,'host_settings_approval_invalid');}
   const nonce=randomBytes(32).toString('base64url');
   const html=`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Host 設定批准</title><main><h1>確認這次 Host 設定操作</h1><p>請核對操作、身份、版本和設定內容。批准只授權這次請求，執行仍取決於目前運行條件。</p><pre id="review"></pre><button id="approve" type="button">批准這次操作</button><pre id="result"></pre></main><script id="review-data" type="application/json">${escapeJson(page)}</script><script nonce="${nonce}">(()=>{const p=JSON.parse(document.getElementById('review-data').textContent),button=document.getElementById('approve');document.getElementById('review').textContent=JSON.stringify(p.review,null,2);button.addEventListener('click',async()=>{button.disabled=true;try{const response=await fetch(${JSON.stringify(PATH)},{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({challenge_id:p.challenge_id,owner_page_nonce:p.owner_page_nonce,review_sha256:p.review_sha256,decision:'approve'})}),result=await response.json();document.getElementById('result').textContent=JSON.stringify(result,null,2);if(result.status==='approved'&&result.purpose==='settings.update'&&window.opener)window.opener.postMessage({type:'jot-host-settings-write-approved',challenge_id:p.challenge_id,review_sha256:p.review_sha256},${JSON.stringify(jotOrigin??'')});}catch{document.getElementById('result').textContent='結果不確定，請查詢原操作，不要重送設定。';}p.owner_page_nonce='';});})();</script></html>`;
   return new Response(html,{headers:{...headers(),'content-type':'text/html; charset=utf-8',
    'content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`}});
  }
  if(request.method!=='POST')return deny(405,'method_not_allowed');
  if((request.headers.get('content-type')??'').split(';')[0].trim()!=='application/json')return deny(415,'content_type_invalid');
  let body;try{
   const reader=request.body?.getReader();if(!reader)return deny(400,'body_invalid');
   const chunks=[];let size=0;
   for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4096){await reader.cancel();return deny(413,'body_too_large');}chunks.push(Buffer.from(part.value));}
   body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{return deny(400,'body_invalid');}
  if(!body||Object.keys(body).sort().join(',')!=='challenge_id,decision,owner_page_nonce,review_sha256'||body.decision!=='approve')return deny(422,'host_settings_approval_invalid');
  const entry=requests.get(body.challenge_id);if(!entry)return deny(409,'host_settings_approval_invalid');
  let approval;try{approval=await authority.approve({...body,peer});}catch{return deny(409,'host_settings_approval_stale');}
  requests.delete(body.challenge_id);
  if(approval.kind==='owner_settings_reconcile'){
   const result=await source.reconcile({request:entry.request,authority,approval,expected_review_sha256:body.review_sha256});
   return Response.json(result,{status:result.status==='reconciled'?200:409,headers:headers()});
  }
  // Keep the approved grant private; no raw capability is returned to a browser.
  // The original exact write request consumes this grant after its Gateway guards pass.
  approvedWrites.set(body.review_sha256,{approval,expires_at:entry.expires_at});
  return Response.json({status:'approved',purpose:'settings.update',execution:'held'},{headers:headers()});
 }};
 return Object.freeze({prepare,ownerRoute,async consumeApprovedWrite(request){
  purge();let digest;
  try{digest=hostSettingsOwnerReviewDigest(await source.readReview(request));}catch{return{ok:false};}
  const entry=approvedWrites.get(digest);if(!entry)return{ok:false};approvedWrites.delete(digest);
  return authority.consume({approval:entry.approval,purpose:'settings.update',expected_review_sha256:digest});
 }});
}
