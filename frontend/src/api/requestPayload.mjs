import { localDateTimePartsToUtc } from '../app/dateTime.mjs';
import { schedulePreferencesFromInput } from './schedulePreferences.mjs';
export function requestPayload(input, role) {
  return {
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
}
export function afterActionPayload(input, actual) {
  const payload = requestPayload(input, 'team'); delete payload.schedulePreferences; delete payload.personalContact;
  return { ...payload, actualRequesterText: input.requesterDisplayText, completedConfirmed: actual.done, actualStartedAt: localDateTimePartsToUtc(actual.startedDate, actual.startedTime), actualCompletedAt: localDateTimePartsToUtc(actual.completedDate, actual.completedTime), reason: actual.reason, completionMemo: actual.memo };
}
