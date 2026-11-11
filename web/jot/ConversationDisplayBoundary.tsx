import React from 'react';
import {recordUiDiagnostic,type UiDiagnostic} from './ui-diagnostics';

/** Keep the owning conversation, composer and original pending commands mounted. */
export default class ConversationDisplayBoundary extends React.Component<
 {label:string;children:React.ReactNode}, {failed:boolean;diagnostic?:UiDiagnostic|undefined}
>{
 state:{failed:boolean;diagnostic?:UiDiagnostic|undefined}={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(error:Error){this.setState({diagnostic:recordUiDiagnostic('react-boundary',error)});}
 render(){
  if(this.state.failed)return <section role="alert" className="jot-display-recovery" data-chat-search-ignore>
   <p>{this.props.label}暂时无法显示。可在当前会话重试。</p>
   <button type="button" onClick={()=>{recordUiDiagnostic('local-retry');this.setState({failed:false,diagnostic:undefined});}}>重新显示{this.props.label}</button>
   {this.state.diagnostic&&<details><summary>界面故障信息（不含对话内容）</summary><pre>{JSON.stringify(this.state.diagnostic,null,2)}</pre></details>}
  </section>;
  return this.props.children;
 }
}
