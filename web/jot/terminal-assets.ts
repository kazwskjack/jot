type Disposable={dispose():void};
export type TerminalBuffer={baseY:number;cursorY:number;length:number;
  getLine(index:number):{isWrapped:boolean;translateToString(trimRight?:boolean):string}|undefined};
export type TerminalApi={
  cols:number;rows:number;options:{disableStdin:boolean};
  buffer:{active:TerminalBuffer};
  open(node:HTMLElement):void;loadAddon(addon:Disposable):void;dispose():void;
  write(text:string,callback:()=>void):void;reset():void;resize(cols:number,rows:number):void;
  focus():void;scrollToBottom():void;paste(text:string):void;
  hasSelection():boolean;getSelection():string;
  onData(listener:(text:string)=>void):Disposable;
  attachCustomKeyEventHandler(listener:(event:KeyboardEvent)=>boolean):void;
};
type FitApi=Disposable&{proposeDimensions():{cols:number;rows:number}|undefined};
type GlApi=Disposable&{onContextLoss(listener:()=>void):Disposable};
type Libraries={
  Terminal:new(options:Record<string,unknown>)=>TerminalApi;
  FitAddon:new()=>FitApi;
  WebLinksAddon:new(handler:(event:MouseEvent,uri:string)=>void)=>Disposable;
  WebglAddon:new()=>GlApi;
};
const assets=new Map<string,Promise<void>>();
function load(url:string,css=false) {
  const existing=assets.get(url);if(existing)return existing;
  const promise=new Promise<void>((resolve,reject)=>{
    const node=css?document.createElement('link'):document.createElement('script');
    if(node instanceof HTMLLinkElement){node.rel='stylesheet';node.href=url;}
    else{node.src=url;node.async=true;}
    node.onload=()=>{node.onload=null;node.onerror=null;resolve();};
    node.onerror=()=>{node.remove();assets.delete(url);reject(Error('终端资源加载失败，可重新连接。'));};
    document.head.append(node);
  });
  assets.set(url,promise);return promise;
}
export async function loadTerminalAssets():Promise<Libraries> {
  const root='/terminal-preview';
  await Promise.all([
    load(root+'/xterm/5.5.0/xterm.css',true),
    load(root+'/xterm/5.5.0/xterm.js'),
  ]);
  await Promise.all([
    load(root+'/addon-fit/0.11.0/addon-fit.js'),
    load(root+'/addon-web-links/0.11.0/addon-web-links.js'),
    load(root+'/addon-webgl/0.19.0/addon-webgl.js'),
  ]);
  const values=globalThis as unknown as {Terminal?:Libraries['Terminal'];FitAddon?:{FitAddon?:Libraries['FitAddon']};
    WebLinksAddon?:{WebLinksAddon?:Libraries['WebLinksAddon']};WebglAddon?:{WebglAddon?:Libraries['WebglAddon']}};
  if(typeof values.Terminal!=='function'||typeof values.FitAddon?.FitAddon!=='function'
    ||typeof values.WebLinksAddon?.WebLinksAddon!=='function'||typeof values.WebglAddon?.WebglAddon!=='function')throw Error('终端资源接口不匹配');
  return {Terminal:values.Terminal,FitAddon:values.FitAddon.FitAddon,WebLinksAddon:values.WebLinksAddon.WebLinksAddon,WebglAddon:values.WebglAddon.WebglAddon};
}
