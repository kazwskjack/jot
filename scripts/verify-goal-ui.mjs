// Built UI + synthetic HTTP fixtures only. No provider, production site or credentials.
import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';import {chromium} from 'playwright';
import {randomBytes} from 'node:crypto';
const dist=fileURLToPath(new URL('../dist/',import.meta.url)),errors=[],controls=[],messages=[];
const fixtureCsrf=randomBytes(24).toString('hex');
const server=createServer(async(req,res)=>{try{const target=resolve(dist,'.'+new URL(req.url,'http://localhost').pathname);if(!target.startsWith(resolve(dist)+sep))throw Error('invalid_path');const bytes=await readFile(target);res.writeHead(200,{'content-type':({'.html':'text/html','.js':'application/javascript','.css':'text/css'}[extname(target)]??'application/octet-stream')});res.end(bytes);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
const fresh=()=>({id:'goal-fixture',revision:1,objective:'Compare verified sources and write a short report',phase:'active',activation:'armed',roundsStarted:2,maxGoalRounds:Number.MAX_SAFE_INTEGER});
let goal=fresh(),running=true,losePause=true,goalReads=0;
const snapshot=id=>({conversation:{conversation_id:id,title:'Synthetic conversation'},as_of_seq:'0',messages:[],runs:running?[{run_id:'run-fixture',conversation_id:id,status:'running',version:1}]:[],activities:[],sources:[],interactions:[],artifacts:[],stream_cursors:[]});
try{
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});const page=await browser.newPage({viewport:{width:1100,height:820}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==origin){await route.abort();throw Error('external_request');}
  if(!url.pathname.startsWith('/workbench-api/'))return route.continue();
  const path=url.pathname.replace('/workbench-api/v1',''),method=request.method(),json=async value=>route.fulfill({status:200,contentType:'application/json',headers:{'x-csrf-token':fixtureCsrf},body:JSON.stringify(value)});
  if(path==='/capabilities')return json({workspaces:[{workspace_id:'ws',title:'Workspace'}],limits:{max_upload_bytes:10000},workbench:{enabled:true,agent_roles:true,execution_ready:true,allowed_tools:[]}});
  if(path==='/agents')return json({items:[{agent_id:'role-fixture',name:'Synthetic role',instructions:'Review fixture evidence',workspace_id:'ws',conversation_id:'role-conversation',allowed_tools:[],status:'active'}]});
  if(path==='/conversations')return json({items:[{conversation_id:'ordinary-fixture',title:'Synthetic ordinary chat'}]});
  if(path.endsWith('/snapshot'))return json(snapshot(path.split('/')[2]));
  if(path.endsWith('/events'))return route.fulfill({status:200,contentType:'text/event-stream',body:': synthetic stream\n\n'});
  if(path.endsWith('/goal')){
   goalReads++;assert.ok(!path.includes('role-conversation'),'role must not probe ordinary Goals');
   if(method==='GET')return json({goal});
   const body=request.postDataJSON(),key=request.headers()['idempotency-key'];controls.push({body,key});assert.equal(request.headers()['x-csrf-token'],fixtureCsrf);assert.ok(key);
   if(body.action==='pause'&&losePause){losePause=false;return route.abort('failed');}
   assert.equal(body.id,goal.id);assert.equal(body.revision,goal.revision);
   goal=body.action==='stop'?null:{...goal,revision:goal.revision+1,phase:body.action==='pause'?'paused':'active',activation:body.action==='pause'?'disarmed':'armed'};return json({goal});
  }
  if(path.endsWith('/messages')&&method==='POST'){messages.push(request.postDataJSON());return json({accepted:true,message_id:'message-fixture',run_id:'run-fixture',conversation_id:'ordinary-fixture'});}
  throw Error('unexpected_fixture_request');
 });
 const open=async()=>{await page.goto(origin+'/workbench.html');await page.getByRole('button',{name:'我的对话',exact:true}).click();await page.getByRole('button',{name:'Synthetic ordinary chat',exact:true}).click();await page.getByText('目标进行中',{exact:true}).waitFor();};
 await open();await page.getByRole('button',{name:'更多消息选项'}).click();const option=page.getByRole('menuitemcheckbox',{name:'目标模式'});assert.equal(await option.getAttribute('aria-checked'),'false');await option.click();assert.equal(await page.getByPlaceholder('描述你的目标…').count(),1);
 await page.getByRole('button',{name:'暂停',exact:true}).click();await page.getByRole('button',{name:'重试原目标操作'}).waitFor();assert.equal(await page.getByRole('region',{name:'Ordinary conversation'}).getByRole('button',{name:'返回工作台',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'重试原目标操作'}).click();await page.getByText('目标已暂停',{exact:true}).waitFor();assert.deepEqual(controls[0],controls[1]);await page.getByRole('button',{name:'继续',exact:true}).click();await page.getByText('目标进行中',{exact:true}).waitFor();
 await page.getByRole('button',{name:'停止',exact:true}).click();assert.equal(controls.length,3);await page.getByRole('button',{name:'确认停止目标'}).click();await page.getByRole('region',{name:'当前目标'}).waitFor({state:'hidden'});assert.equal(goal,null);
 await page.getByPlaceholder('描述你的目标…').fill('Find three trustworthy sources');await page.getByRole('button',{name:'加入队列',exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea')?.value==='');assert.equal(messages.length,1);assert.match(messages[0].content[0].text,/create_goal/);assert.ok(messages[0].content[0].text.endsWith('Find three trustworthy sources'));
 goal={...fresh(),phase:'paused',activation:'disarmed'};running=false;await page.reload();await page.getByRole('button',{name:'我的对话',exact:true}).click();await page.getByRole('button',{name:'Synthetic ordinary chat',exact:true}).click();await page.getByText('目标已暂停',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'继续',exact:true}).isDisabled(),true);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.getByRole('button',{name:'更多消息选项'}).isVisible(),true);
 if(process.env.JOT_GOAL_SCREENSHOT_DIR){await mkdir(process.env.JOT_GOAL_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:resolve(process.env.JOT_GOAL_SCREENSHOT_DIR,'goal-mobile.png'),fullPage:true});}
 await page.getByRole('region',{name:'Ordinary conversation'}).getByRole('button',{name:'返回工作台',exact:true}).click();await page.getByRole('banner').getByRole('button',{name:'返回工作台',exact:true}).click();await page.getByRole('button',{name:'进入对话',exact:true}).click();await page.getByRole('textbox',{name:'角色消息',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'更多消息选项'}).count(),0);assert.equal(await page.getByRole('region',{name:'当前目标'}).count(),0);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'PASS',syntheticOnly:true,goalMenu:true,exactRetry:true,pauseResumeStop:true,coldResumeDisabled:true,roleIsolated:true,mobileOverflow:false,goalReads,controls:controls.length,messages:messages.length}));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
