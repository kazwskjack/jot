// Menu actions adapt PilotDeck 783499ff desktopCommands; AGPL-3.0, see THIRD_PARTY_NOTICES.md.
export const desktopMenuCommands=Object.freeze(['new-conversation','new-project','settings','check-updates','find','toggle-sidebar','chat','files','skills','scheduled-tasks']);
export const emptyDesktopMenuState=Object.freeze({protocol:1,owner_scope:null,ready:false,blocked:true,enabled_commands:Object.freeze([]),sidebar_visible:false});
export function parseDesktopMenuState(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype
  ||Object.keys(value).sort().join(',')!=='blocked,enabled_commands,owner_scope,protocol,ready,sidebar_visible'
  ||value.protocol!==1||typeof value.ready!=='boolean'||typeof value.blocked!=='boolean'||typeof value.sidebar_visible!=='boolean'
  ||value.owner_scope!==null&&(typeof value.owner_scope!=='string'||!/^[a-f0-9]{64}$/.test(value.owner_scope))
  ||value.ready&&value.owner_scope===null||!Array.isArray(value.enabled_commands)||value.enabled_commands.length>desktopMenuCommands.length
  ||new Set(value.enabled_commands).size!==value.enabled_commands.length||value.enabled_commands.some(command=>!desktopMenuCommands.includes(command))
  ||!value.ready&&value.enabled_commands.length)throw Error('desktop_menu_state_invalid');
 return Object.freeze({...value,enabled_commands:Object.freeze([...value.enabled_commands])});
}
export function desktopMenuCommandEnabled(command,state){return desktopMenuCommands.includes(command)&&state.ready===true&&state.blocked===false&&state.owner_scope!==null&&state.enabled_commands.includes(command);}
