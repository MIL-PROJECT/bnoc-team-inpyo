import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestReuseFields } from './requestReuse.mjs';

test('reuse copies only active request inputs and never old schedules attachments or business state', () => {
  const source = { category:'회의 지원', subcategories:{meetingType:'화상회의',videoPlatform:'KJCCS',systemType:'인터넷'}, detail:'회의 연결 지원', location:'회의실', contact:'000-0000', personalContact:'', equipmentId:'장비 식별정보', documentRef:'관련 문서', requestNumber:'101', status:'완료', priority:'urgent', revision:9, requesterRef:'old-owner', maintenanceTarget:{name:'excluded'}, schedulePreferences:[{rank:1,date:'2026-10-25',period:'AM'}], attachments:[{id:'old-file'}], workItems:[{status:'완료'}], history:[{field:'완료'}], operationId:'old-key' };
  const before = structuredClone(source);
  assert.deepEqual(requestReuseFields(source), { category:'회의 지원',meetingType:'화상회의',videoPlatform:'KJCCS',detail:source.detail,location:source.location,contact:source.contact,personalContact:'',equipmentId:source.equipmentId,documentRef:source.documentRef }, 'REUSE_ALLOWLIST_ONLY');
  assert.deepEqual(source,before,'SOURCE_REQUEST_MUST_NOT_CHANGE');
});

test('equipment reuse excludes inactive meeting and phone subtype values', () => {
  const copy=requestReuseFields({category:'장비/체계',subcategories:{systemType:'인터넷',resourceType:'PC',workType:'지원',phoneType:'IP',meetingType:'화상회의',videoPlatform:'KJCCS'},detail:'점검',location:'사무실',contact:'000-0000'});
  assert.equal(copy.systemType,'인터넷');assert.equal(copy.resourceType,'PC');assert.equal(copy.workType,'지원');
  assert.equal(Object.hasOwn(copy,'meetingType'),false);assert.equal(Object.hasOwn(copy,'videoPlatform'),false);assert.equal(Object.hasOwn(copy,'phoneType'),false);
  assert.equal(copy.personalContact,'');assert.equal(copy.documentRef,'');
});
