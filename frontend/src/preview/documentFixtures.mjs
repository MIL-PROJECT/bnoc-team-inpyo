export function documentFixtures(number) {
  const blocks=[{id:'b1',type:'paragraph',text:'회의 지원 요청서'},{id:'b2',type:'paragraph',text:'회의명: 정기회의'},{id:'b3',type:'paragraph',text:'일시: 2026-10-23 10:00'},{id:'b4',type:'paragraph',text:'장소: 회의실'},{id:'b5',type:'paragraph',text:'지원 내용: 음향 장비 연결과 마이크 점검'},{id:'b6',type:'paragraph',text:'장소 후보: 소회의실 (예비 장소)'}];
  const metadata=[{label:'문서 제목',values:[{rawValue:'회의 지원 요청서',blockId:'b1'}]},{label:'회의명',values:[{rawValue:'정기회의',blockId:'b2'}]},{label:'일시',values:[{rawValue:'2026-10-23 10:00',blockId:'b3'}]},{label:'장소',values:[{rawValue:'회의실',blockId:'b4'},{rawValue:'소회의실 (예비 장소)',blockId:'b6'}]}];
  const hwp={id:'doc1',name:'회의지원.hwp',status:'ready',format:'hwp',blocks,metadata,originalUrl:new URL('./fixtures/support.hwp',import.meta.url).href};
  const pdf={id:'pdf1',name:'Equipment-support.pdf',status:'ready',format:'pdf',blocks:[{id:'p1',text:'Equipment support request. Date: 2026-10-23 10:00. Location: Conference room. Audio setup.'}],metadata:[{label:'일시',values:[{rawValue:'2026-10-23 10:00',blockId:'p1'}]},{label:'장소',values:[{rawValue:'Conference room',blockId:'p1'}]}]};
  if(number==='101')return [hwp,pdf];
  if(number==='102')return ['processing','partial','failed','unreadable','no_text'].map((status,index)=>({...hwp,id:'state'+index,name:['분석중.hwp','일부추출.hwp','분석실패.hwp','읽기불가.hwp','텍스트없음.hwp'][index],status,blocks:status==='partial'?blocks.slice(0,3):[],metadata:status==='partial'?metadata.slice(0,3):[]}));
  return [];
}
export function pdfBlob() {
  const text='BT /F1 17 Tf 45 740 Td (Equipment support request) Tj 0 -35 Td /F1 12 Tf (Date: 2026-10-23 10:00) Tj 0 -24 Td (Location: Conference room) Tj 0 -24 Td (Audio setup.) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,object] of objects.entries()){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;}
  const start=pdf.length;pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new Blob([pdf],{type:'application/pdf'});
}
