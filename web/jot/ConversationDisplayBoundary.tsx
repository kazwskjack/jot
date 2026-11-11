import {ApplicationLanguageContext,applicationText} from './application-language';
import React from 'react';
import {recordUiDiagnostic,type UiDiagnostic} from './ui-diagnostics';

/** Keep the owning conversation, composer and original pending commands mounted. */
export default class ConversationDisplayBoundary extends React.Component<
 {label:string;children:React.ReactNode}, {failed:boolean;diagnostic?:UiDiagnostic|undefined}
>{
 static contextType=ApplicationLanguageContext;
 declare context:React.ContextType<typeof ApplicationLanguageContext>;
 state:{failed:boolean;diagnostic?:UiDiagnostic|undefined}={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(error:Error){this.setState({diagnostic:recordUiDiagnostic('react-boundary',error)});}
 render(){
  const t=applicationText(this.context);
  if(this.state.failed)return <section lang={this.context} role="alert" className="jot-display-recovery" data-chat-search-ignore>
   <p>{t(`${this.props.label}暂时无法显示。可在当前会话重试。`,`${this.props.label} cannot be displayed right now. You can retry in the current conversation.`)}</p>
   <button type="button" onClick={()=>{recordUiDiagnostic('local-retry');this.setState({failed:false,diagnostic:undefined});}}>{t(`重新显示${this.props.label}`,`Show ${this.props.label} Again`)}</button>
   {this.state.diagnostic&&<details><summary>{t('界面故障信息（不含对话内容）','Interface diagnostics (without conversation content)')}</summary><pre>{JSON.stringify(this.state.diagnostic,null,2)}</pre></details>}
  </section>;
  return this.props.children;
 }
}
