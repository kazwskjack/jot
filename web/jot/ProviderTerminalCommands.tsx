// Provider CLI entry adapts pinned PilotDeck ProviderLoginModal/StandaloneShell; AGPL-3.0.
import {useState} from 'react';
import {useApplicationLanguage,useApplicationText} from './application-language';
import type {TerminalInfo} from '../../packages/gateway/src/terminal/inventory.js';

const presets=[
 {id:'pilotdeck',label:'OpenBMB PilotDeck',command:'pilotdeck /login'},
 {id:'claude',label:'Anthropic Claude',command:'claude /login'},
 {id:'cursor',label:'Cursor',command:'cursor-agent login'},
 {id:'codex',label:'Codex',command:'codex login'},
 {id:'codex-device',label:'Codex (device auth)',command:'codex login --device-auth'},
 {id:'gemini',label:'Gemini',command:'gemini status'},
] as const;

export default function ProviderTerminalCommands({terminal,disabled,onSend}:{
 terminal:Pick<TerminalInfo,'id'|'title'|'cwd'>;disabled:boolean;onSend:(command:string)=>boolean;
}){
 const language=useApplicationLanguage(),t=useApplicationText(),[command,setCommand]=useState('');
 const valid=command.length<=4096&&command.trim().length>0&&!/[\x00-\x1f\x7f]/.test(command);
 return <details lang={language}>
  <summary>{t('提供方 CLI 登录与配置','Provider CLI Login and Configuration')}</summary>
  <p>{t('目标终端：','Target Terminal: ')}{terminal.title} · <code>{terminal.id}</code></p>
  <p>{t('终端初始目录：','Terminal Initial Directory: ')}<code style={{overflowWrap:'anywhere'}}>{terminal.cwd}</code></p>
  <label>{t('提供方命令','Provider Command')} <select disabled={disabled} value={presets.find(item=>item.command===command)?.id??''} onChange={event=>{const preset=presets.find(item=>item.id===event.currentTarget.value);if(preset)setCommand(preset.command);}}>
   <option value="">{t('选择提供方或编辑命令','Choose a Provider or Edit the Command')}</option>
   {presets.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
  </select></label>
  <label>{t('要发送的单行命令','Single-line Command to Send')} <input value={command} maxLength={4096} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event=>setCommand(event.currentTarget.value)} style={{width:'100%'}}/></label>
  <button type="button" disabled={disabled||!valid} onClick={()=>{if(!disabled&&valid&&onSend(command))setCommand('');}}>{t('发送命令并回车','Send Command and Enter')}</button>
  <p>{t('先核对终端屏幕、当前程序与目录。点击后命令和回车会发送到此终端；需要已安装相应 CLI。登录结果以提供方原始输出为准。','Check the terminal screen, current program and directory first. Clicking sends the command and Enter to this terminal; the corresponding CLI must be installed. Use the provider’s original output to determine the login result.')}</p>
  <p>{t('命令草稿只保留在当前视图中。Gemini 凭据在原 CLI 中配置；此处不保存 API 密钥。','The command draft stays only in this view. Configure Gemini credentials in the original CLI; API keys are not stored here.')}</p>
 </details>;
}
