/** One text vocabulary serves activity display, result pages and historical search. */
export function nativeFileSearchRows(result,language='zh-CN') {
  const t=(zh,en)=>language==='en'?en:zh;
  if(result.shape==='source_limit')return [{label:t('原生搜索结果','Native Search Result'),value:t('原公开元数据超过 512 KiB 活动内联范围，当前未展示其路径或命中正文。','Original public metadata exceeds the 512 KiB activity inline limit. Paths and matching text are not shown here.')}];
  const rows=[{label:t('原生结果总数','Native Result Count'),value:String(result.total)},
    {label:t('原生保留范围','Native Retained Coverage'),value:result.truncated?t('原工具已截断，当前仅展示已保留结果。','The original tool truncated its output. Only retained results are shown.'):t('原工具已保留全部结果。','The original tool retained all results.')}];
  if(result.shape==='paths'){
    if(result.paths.length)rows.push({label:t('匹配文件','Matching Files'),value:result.paths.join('\n')});
  }else for(const file of result.files)rows.push({label:t(`文件 ${file.path}`,`File ${file.path}`),
    value:file.matches.length?file.matches.map(match=>`${match.lineNumber}: ${match.line}`).join('\n'):t('没有保留命中行','No matching lines were retained')});
  return rows;
}
