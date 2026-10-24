const normalized=value=>String(value??'').normalize('NFC').toLocaleLowerCase('ko-KR');
export function searchRequests(rows,criteria={}) {
  const q=normalized(criteria.q?.trim());
  if(q.length>200)throw new Error('검색어는 200자 이하로 입력하세요.');
  return rows.flatMap(row=>{
    if(criteria.requestNumber&&row.number!==criteria.requestNumber||criteria.status&&row.status!==criteria.status||criteria.category&&row.category!==criteria.category||criteria.workType&&row.workType!==criteria.workType||criteria.teamId&&!(row.teamIds??[row.teamId]).includes(criteria.teamId)||criteria.location&&!normalized(row.location).includes(normalized(criteria.location))||criteria.requesterDeptOrName&&!normalized(row.requesterDisplayText??'요청 부서').includes(normalized(criteria.requesterDeptOrName))||criteria.from&&row.registeredAt.slice(0,10)<criteria.from||criteria.to&&row.registeredAt.slice(0,10)>criteria.to)return [];
    const sources=[{source:'요청 내용',text:[row.title,row.detail,row.category,row.systemType,row.resourceType,row.workType].filter(Boolean).join(' ')},...(row.documents??[]).filter(doc=>doc.linked!==false&&['ready','partial'].includes(doc.status)).flatMap(doc=>[{source:`문서 본문 · ${doc.name}`,text:doc.blocks?.map(block=>block.text??block.rows?.flat().join(' ')).join(' ')??'',attachmentRef:doc.id,blockId:doc.blocks?.find(block=>normalized(block.text??block.rows?.flat().join(' ')).includes(q))?.id},{source:`문서 정보 · ${doc.name}`,text:doc.metadata?.flatMap(field=>field.values.map(value=>value.rawValue)).join(' ')??'',attachmentRef:doc.id,blockId:doc.metadata?.flatMap(field=>field.values).find(value=>normalized(value.rawValue).includes(q))?.blockId}])];
    const matches=q?sources.filter(source=>normalized(source.text).includes(q)).map(source=>{const index=normalized(source.text).indexOf(q);return {...source,text:source.text.slice(Math.max(0,index-45),Math.max(0,index-45)+160)};}):[];
    return q&&!matches.length?[]:[{...row,matches}];
  });
}
