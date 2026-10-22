import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDetailGuidance, requestLocationGuidance } from './requestGuidance.mjs';

test('request guidance is distinct for every equipment classification combination', () => {
  const systems = ['인트라넷', '인터넷', 'AFCCS', 'KJCCS', '기타'];
  const resources = ['PC', '프린터', '회선', '전화', '기타'];
  const workTypes = ['신설', '고장', '지원', '대여', '점검', '이전', '기타'];
  const examples = systems.flatMap(systemType => resources.flatMap(resourceType => workTypes.map(workType =>
    requestDetailGuidance({ category: '장비/체계', systemType, resourceType, workType })
  )));
  assert.equal(examples.length, 175);
  assert.equal(new Set(examples).size, 175);
  assert.ok(examples.every(example => example.startsWith('예:')));
  const pcExamples = workTypes.map(workType => requestDetailGuidance({ category: '장비/체계', systemType: '인트라넷', resourceType: 'PC', workType }));
  assert.equal(new Set(pcExamples).size, workTypes.length);
  assert.ok(pcExamples[workTypes.indexOf('고장')].includes('발생 증상'));
  assert.ok(pcExamples[workTypes.indexOf('신설')].includes('새로 설치할 위치'));
  assert.ok(!pcExamples[workTypes.indexOf('신설')].includes('발생 증상'));
});

test('meeting guidance follows meeting type and location guidance stays generic', () => {
  const examples = ['화상회의', '일반회의', '기타'].map(meetingType => requestDetailGuidance({ category: '회의 지원', meetingType }));
  assert.equal(new Set(examples).size, 3);
  assert.equal(requestLocationGuidance, '예: 건물 층 부서명 등 작업 위치를 적어주세요.');
});
