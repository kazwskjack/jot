// Keep status-only imports lightweight. Workbench imports AgentPanel.tsx only
// when the Agent view is selected; this module remains safe for shell imports.
export {ResourceStatus,Empty} from './PanelStatus';
