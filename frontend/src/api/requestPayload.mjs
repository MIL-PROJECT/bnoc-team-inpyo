import { localDateTimePartsToUtc } from '../app/dateTime.mjs';
import { schedulePreferencesFromInput } from './schedulePreferences.mjs';
import { intakePayload,intakeItemText } from '../app/intakeModel.mjs';
export function requestPayload(input, role) {
  const guided=role!=='team'?input.guidedDraft:null;
  const base={
    ...(role === 'bnoc' ? { requesterRef: input.requesterRef } : {}),
    category: input.category,
    subcategories: input.category === '장비/체계'
      ? { systemType: input.systemType, resourceType: input.resourceType, workType: input.workType, ...(input.resourceType === '전화' && input.phoneType ? { phoneType: input.phoneType } : {}) }
      : { meetingType: input.meetingType, ...(input.meetingType === '화상회의' && input.videoPlatform ? { videoPlatform: input.videoPlatform } : {}) },
    detail: input.detail, location: input.location, contact: input.contact,
    ...(input.personalContact?.trim() ? { personalContact: input.personalContact.trim() } : {}),
    ...(input.equipmentId ? { equipmentId: input.equipmentId } : {}),
    ...(schedulePreferencesFromInput(input).length ? { schedulePreferences: schedulePreferencesFromInput(input) } : {}),
    ...(input.documentRef ? { documentRef: input.documentRef } : {}),
    ...(input.differentTarget ? { maintenanceTarget: { department: input.targetDepartment, rank: input.targetRank, name: input.targetName, phone: input.targetPhone } } : {}),
    attachments: input.attachments
  };
  if(!guided)return base;
  if(guided.mode==='meeting'){
    const meeting=guided.meeting,ids=new Set(meeting.attachmentIds??[]);
    return {...base,category:'회의 지원',subcategories:{meetingType:meeting.meetingType,...(meeting.meetingType==='화상회의'?{videoPlatform:meeting.videoPlatform}:{})},detail:meeting.detail,location:meeting.location,attachments:input.attachments.filter(file=>ids.has(file.id)),equipmentId:undefined};
  }
  const payload=intakePayload(guided),ids=new Set(payload.requestItems.flatMap(item=>item.attachmentIds));
  return {...base,...payload,category:'장비/체계',subcategories:{},detail:guided.items.map(intakeItemText).join('\n').slice(0,10000),location:guided.items[0]?.location??'',equipmentId:undefined,attachments:input.attachments.filter(file=>ids.has(file.id))};
}
export function afterActionPayload(input, actual) {
  const payload = requestPayload(input, 'team'); delete payload.schedulePreferences; delete payload.personalContact;
  return { ...payload, requesterRef: input.requesterRef, completedConfirmed: actual.done, actualStartedAt: localDateTimePartsToUtc(actual.startedDate, actual.startedTime), actualCompletedAt: localDateTimePartsToUtc(actual.completedDate, actual.completedTime), reason: actual.reason, completionMemo: actual.memo };
}
