export function dialogTabBoundaryTarget(activeElement,focusableElements,shiftKey){
 if(!focusableElements.length)return null;
 const first=focusableElements[0],last=focusableElements[focusableElements.length-1];
 if(shiftKey&&activeElement===first)return last;
 if(!shiftKey&&activeElement===last)return first;
 return null;
}
