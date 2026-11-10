import type {OfficeDocumentPreview} from '../../packages/gateway/src/artifacts/document-preview-content';
import type {TextContentReference} from './vendor/pilotdeck-content-reference';

export type OfficeTextBlock={key:string;text:string;offset:number;part:number;page:number;table:number;column:number;slide?:number};
export type OfficeTextView={kind:'docx'|'pptx';text:string;blocks:OfficeTextBlock[];byKey:ReadonlyMap<string,OfficeTextBlock>;truncated:boolean};

/** Protocol 1 keeps paragraph/table-cell or slide ordering independent of local paging. */
export function officeTextView(value:Exclude<OfficeDocumentPreview,{kind:'xlsx'}>):OfficeTextView{
 const blocks:OfficeTextBlock[]=[],parts:string[]=[],byKey=new Map<string,OfficeTextBlock>();let offset=0;
 const append=(text:string,location:Omit<OfficeTextBlock,'text'|'offset'>)=>{
  if(!text.trim())return;
  if(parts.length)offset++;
  const block={...location,text,offset};blocks.push(block);byKey.set(block.key,block);parts.push(text);offset+=text.length;
 };
 if(value.kind==='docx'){
  value.paragraphs.forEach((text,index)=>append(text,{key:'paragraph-'+index,part:0,page:Math.floor(index/30),table:0,column:0}));
  for(const [tableIndex,table]of value.tables.entries()){
   for(const [rowIndex,row]of table.entries()){
    for(const [columnIndex,text]of row.entries()){
     append(text,{key:`table-${tableIndex}-row-${rowIndex}-column-${columnIndex}`,part:1,page:Math.floor(rowIndex/20),table:tableIndex,column:Math.floor(columnIndex/20)});
    }
   }
  }
 }else{
  if(new Set(value.slides.map(slide=>slide.number)).size!==value.slides.length)throw Error('原幻灯片编号重复，无法确认文字位置。');
  value.slides.forEach((slide,index)=>append(slide.text,{key:'slide-'+slide.number,part:0,page:Math.floor(index/10),table:0,column:0,slide:slide.number}));
 }
 return {kind:value.kind,text:parts.join('\n'),blocks,byKey,truncated:value.truncated};
}

/** Linear matching keeps overlapping repeated quotations bounded by source size. */
export function officeTextOccurrence(text:string,query:string,target:{offset:number}|{index:number}){
 if(!query.length)return undefined;
 const prefix=new Int32Array(query.length);let occurrence=0;
 for(let index=1,matched=0;index<query.length;index++){
  while(matched>0&&query[index]!==query[matched])matched=prefix[matched-1];
  if(query[index]===query[matched])matched++;
  prefix[index]=matched;
 }
 for(let index=0,matched=0;index<text.length;index++){
  while(matched>0&&text[index]!==query[matched])matched=prefix[matched-1];
  if(text[index]===query[matched])matched++;
  if(matched===query.length){
   const offset=index-query.length+1;
   if('offset' in target?offset===target.offset:occurrence===target.index)return {offset,index:occurrence};
   occurrence++;matched=prefix[matched-1];
  }
 }
 return undefined;
}

export function resolveOfficeTextReference(view:OfficeTextView,reference:TextContentReference){
 if(reference.renderer.id!==view.kind||reference.locator.occurrenceIndex==null)return undefined;
 const start=officeTextOccurrence(view.text,reference.selectedText,{index:reference.locator.occurrenceIndex})?.offset;
 if(start===undefined)return undefined;
 const end=start+reference.selectedText.length,quote=reference.locator.quote;
 if(quote.prefix!==undefined&&view.text.slice(Math.max(0,start-quote.prefix.length),start)!==quote.prefix
  ||quote.suffix!==undefined&&view.text.slice(end,end+(quote.suffix?.length??0))!==quote.suffix)return undefined;
 const block=view.blocks.find(block=>start>=block.offset&&end<=block.offset+block.text.length);
 if(!block||view.kind==='pptx'&&!reference.locator.slideNumbers?.includes(block.slide!))return undefined;
 return {block,start:start-block.offset,end:end-block.offset};
}
