export const name='jot-chat-tools-policy';
export const inject=['tools'];
export function apply(ctx){
 // The pinned official Host globally registers working_directory. It is a
 // Work capability, not a Chat tool. Scoped web registrations are separate
 // from the SDK's global restriction mask; do not mask them with allow: [].
 ctx.tools.restrict({deny:['working_directory']});
 ctx.tools.presentAs('native');
 ctx.tools.guard(execution=>['web_search','web_fetch'].includes(execution.name)?undefined:'CHAT_READ_ONLY_TOOLS_ONLY');
}
