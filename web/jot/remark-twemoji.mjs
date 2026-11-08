import {parse} from './vendor/twemoji-parser.mjs';

function splitEmojiText(value){
 const emojis=parse(value,{assetType:'svg',buildUrl:codepoints=>`./twemoji/svg/${codepoints}.svg`});
 if(!emojis.length)return[{type:'text',value}];
 const nodes=[];let cursor=0;
 for(const emoji of emojis){
  const[start,end]=emoji.indices;
  if(start>cursor)nodes.push({type:'text',value:value.slice(cursor,start)});
  nodes.push({type:'emphasis',data:{hName:'span',hProperties:{className:['jot-twemoji']}},children:[
   {type:'emphasis',data:{hName:'span',hProperties:{className:['jot-twemoji-source']}},children:[{type:'text',value:emoji.text}]},
   {type:'image',url:emoji.url,alt:emoji.text,data:{hProperties:{className:['jot-twemoji-image'],ariaHidden:true,draggable:false,loading:'lazy',decoding:'async'}}},
  ]});
  cursor=end;
 }
 if(cursor<value.length)nodes.push({type:'text',value:value.slice(cursor)});
 return nodes;
}

export function remarkTwemoji(){
 return tree=>{
  const visit=node=>{
   if(!Array.isArray(node.children))return;
   const children=[];
   for(const child of node.children){
    if(child?.type==='text'&&typeof child.value==='string')children.push(...splitEmojiText(child.value));
    else{visit(child);children.push(child);}
   }
   node.children=children;
  };
  visit(tree);
 };
}
