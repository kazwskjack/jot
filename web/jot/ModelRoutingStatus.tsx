import {useApplicationLanguage,useApplicationText} from './application-language';
import {modelHealthAt,modelRoutingStatus} from './model-routing-status.mjs';
import {useModelHealthClock} from './useModelHealthClock';
import type {Capabilities,ModelSelection} from './types';

export default function ModelRoutingStatus({selection,models}:{selection:ModelSelection;models:Capabilities['models']}){
 const language=useApplicationLanguage(),t=useApplicationText(),now=useModelHealthClock(models);
 const status=modelRoutingStatus(selection,models.map(item=>({...item,health:modelHealthAt(item.health,now)})),language);
 return <aside lang={language} className="jot-model-routing-status" aria-label={t('模型路由状态','Model Routing Status')}><p role="status">{status.primary}</p><p>{status.fallbacks}</p></aside>;
}
