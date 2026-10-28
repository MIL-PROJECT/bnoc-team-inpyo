import { intakeFromRequest } from './intakeModel.mjs';
export function requestReuseFields(source) {
  const text = value => typeof value === 'string' ? value : '';
  const copy = Object.fromEntries(['category','detail','location','contact','personalContact','equipmentId','documentRef'].map(key => [key,text(source[key])]));
  const sub = source.subcategories ?? {};
  const fields = source.category === '장비/체계' ? ['systemType','resourceType','workType',...(sub.resourceType === '전화' ? ['phoneType'] : [])] : ['meetingType',...(sub.meetingType === '화상회의' ? ['videoPlatform'] : [])];
  for (const key of fields) copy[key] = text(sub[key]);
  if(source.requestItems?.length)copy.guidedDraft=intakeFromRequest(source);
  return copy;
}
