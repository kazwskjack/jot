/* Adapted from pinned PilotDeck spreadsheetContextSelectionIntent.ts. See SOURCES.json and LICENSES.txt. */
export function shouldShowSpreadsheetSelectionPopup(origin,regionModeActive){
 return origin==='context-action'&&!regionModeActive;
}

export function createSpreadsheetContextSelectionIntent(){
 let secondaryPointerArmed=false,cellTarget=null;
 const reset=()=>{secondaryPointerArmed=false;cellTarget=null;};
 return {
  recordPointerDown(button,ctrlKey=false){
   secondaryPointerArmed=button===2||(button===0&&ctrlKey);
   if(!secondaryPointerArmed)cellTarget=null;
  },
  recordCellPointerDown(target){
   if(!secondaryPointerArmed)return false;
   cellTarget=target;return true;
  },
  consumeContextAction(){const target=cellTarget;reset();return target;},
  reset
 };
}
