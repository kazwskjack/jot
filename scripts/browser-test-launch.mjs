import {access} from 'node:fs/promises';
import {join} from 'node:path';

const windowsBrowserCandidates=()=>[
 ...[process.env.ProgramFiles,process.env['ProgramFiles(x86)']].filter(Boolean).map(root=>({executable:join(root,'Google','Chrome','Application','chrome.exe')})),
 ...[process.env['ProgramFiles(x86)'],process.env.ProgramFiles].filter(Boolean).map(root=>({executable:join(root,'Microsoft','Edge','Application','msedge.exe')})),
];

async function installedWindowsBrowser(){
 if(process.platform!=='win32')return null;
 for(const candidate of windowsBrowserCandidates())try{await access(candidate.executable);return candidate;}catch{}
 return null;
}

async function selectedBrowser(chromium){
 const override=process.env.JOT_BROWSER_EXECUTABLE;
 if(override){await access(override);return {executable:override};}
 const installed=await installedWindowsBrowser();
 if(installed)return {executable:installed.executable};
 return {executable:chromium.executablePath()};
}

export async function browserTestLaunchOptions(chromium){
 const browser=await selectedBrowser(chromium);return {executablePath:browser.executable};
}

export async function browserTestExecutable(chromium){
 const browser=await selectedBrowser(chromium);return browser.executable;
}
