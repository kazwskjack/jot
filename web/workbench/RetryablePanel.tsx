import {ApplicationLanguageContext,applicationText} from '../jot/application-language';
import React,{Suspense,lazy,useState} from 'react';
import {PanelStatus} from './PanelStatus';
export {PanelStatus} from './PanelStatus';

class PanelErrorBoundary extends React.Component<{label:string;onRetry:()=>void;children:React.ReactNode},{error:Error|null}>{
 static contextType=ApplicationLanguageContext;
 declare context:React.ContextType<typeof ApplicationLanguageContext>;
 state={error:null as Error|null};
 static getDerivedStateFromError(error:Error){return {error};}
 render(){return this.state.error?<PanelStatus loading={false} error={applicationText(this.context)(`${this.props.label} 暂时无法加载：`,`${this.props.label} could not be loaded: `)+this.state.error.message} onRetry={this.props.onRetry} label={this.props.label}/>:this.props.children;}
}

export function RetryablePanel({load,label,props,onBeforeRetry}:{load:()=>Promise<{default:React.ComponentType<any>}>;label:string;props:any;onBeforeRetry?:()=>void}){
 const [Loader]=useState(()=>lazy(load));
 const retry=()=>{onBeforeRetry?.();window.location.reload();};
 return <PanelErrorBoundary label={label} onRetry={retry}><Suspense fallback={<PanelStatus loading error="" onRetry={()=>{}} label={label}/>}><Loader {...props}/></Suspense></PanelErrorBoundary>;
}
