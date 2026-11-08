import emojiRegex from './twemoji-regex.mjs';

// Adapted from @twemoji/parser 17.0.2 dist/index.js.
// Copyright (c) 2022–present Jason Sofonia & Justine De Caires
// Copyright (c) 2018–2021 Twitter. Licensed under MIT; see LICENSE.twemoji-parser.md.
export const TypeName='emoji';

export function parse(text,options={}){
 const assetType=options.assetType||'svg';
 const getTwemojiUrl=options.buildUrl||((codepoints)=>`/twemoji/svg/${codepoints}.svg`);
 const entities=[];
 emojiRegex.lastIndex=0;
 while(true){
  const result=emojiRegex.exec(text);
  if(!result)break;
  const emojiText=result[0],codepoints=toCodePoints(removeVS16s(emojiText)).join('-');
  entities.push({url:codepoints?getTwemojiUrl(codepoints,assetType):'',indices:[result.index,emojiRegex.lastIndex],text:emojiText,type:TypeName});
 }
 return entities;
}

const vs16RegExp=/\uFE0F/g;
const zeroWidthJoiner=String.fromCharCode(0x200d);
const removeVS16s=rawEmoji=>rawEmoji.indexOf(zeroWidthJoiner)<0?rawEmoji.replace(vs16RegExp,''):rawEmoji;

export function toCodePoints(unicodeSurrogates){
 const points=[];let char=0,previous=0,i=0;
 while(i<unicodeSurrogates.length){
  char=unicodeSurrogates.charCodeAt(i++);
  if(previous){points.push((0x10000+((previous-0xd800)<<10)+(char-0xdc00)).toString(16));previous=0;}
  else if(char>0xd800&&char<=0xdbff)previous=char;
  else points.push(char.toString(16));
 }
 return points;
}
