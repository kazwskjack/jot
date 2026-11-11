export type DesktopMenuCommand='new-conversation'|'new-project'|'settings'|'check-updates'|'find'|'toggle-sidebar'|'chat'|'files'|'skills'|'scheduled-tasks';
export type DesktopMenuState=Readonly<{protocol:1;owner_scope:string|null;ready:boolean;blocked:boolean;enabled_commands:readonly DesktopMenuCommand[];sidebar_visible:boolean}>;
export const desktopMenuCommands:readonly DesktopMenuCommand[];
export const emptyDesktopMenuState:DesktopMenuState;
export function parseDesktopMenuState(value:unknown):DesktopMenuState;
export function desktopMenuCommandEnabled(command:unknown,state:DesktopMenuState):boolean;
