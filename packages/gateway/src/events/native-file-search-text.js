/** One text vocabulary serves activity display, result pages and historical search. */
export function nativeFileSearchRows(result) {
  if(result.shape==='source_limit')return [{label:'原生搜索结果',value:'原公开元数据超过 512 KiB 活动内联范围，当前未展示其路径或命中正文。'}];
  const rows=[{label:'原生结果总数',value:String(result.total)},
    {label:'原生保留范围',value:result.truncated?'原工具已截断，当前仅展示已保留结果。':'原工具已保留全部结果。'}];
  if(result.shape==='paths'){
    if(result.paths.length)rows.push({label:'匹配文件',value:result.paths.join('\n')});
  }else for(const file of result.files)rows.push({label:`文件 ${file.path}`,
    value:file.matches.length?file.matches.map(match=>`${match.lineNumber}: ${match.line}`).join('\n'):'没有保留命中行'});
  return rows;
}
