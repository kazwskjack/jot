import React from 'react';

/** Keep the owning conversation, composer and original pending commands mounted. */
export default class ConversationDisplayBoundary extends React.Component<
 {label:string;children:React.ReactNode}, {failed:boolean}
>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){
  if(this.state.failed)return <section role="alert" className="jot-display-recovery" data-chat-search-ignore>
   <p>{this.props.label}暂时无法显示。可在当前会话重试。</p>
   <button type="button" onClick={()=>this.setState({failed:false})}>重新显示{this.props.label}</button>
  </section>;
  return this.props.children;
 }
}
