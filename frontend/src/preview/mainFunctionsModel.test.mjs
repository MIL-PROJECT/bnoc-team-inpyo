import test from 'node:test';
import assert from 'node:assert/strict';
import { absenceOn, personnelCounts, dateRange, calendarDates, combinedRequestStatus, linkedTeamsForRequest, seoulDate, visibleCalendarItems, notificationForChange } from './mainFunctionsModel.mjs';

test('overlapping absences count each person once and block selection at both ends', () => {
  const people = [{ id: 'a' }, { id: 'b' }];
  const absences = [
    { personId: 'a', start: '2026-10-25', end: '2026-10-27', kind: '휴가' },
    { personId: 'a', start: '2026-10-26', end: '2026-10-28', kind: '교육' }
  ];
  assert.deepEqual(personnelCounts(people, absences, '2026-10-26'), { total: 2, absent: 1, present: 1 });
  assert.equal(absenceOn(absences, 'a', '2026-10-25')?.kind, '휴가');
  assert.equal(absenceOn(absences, 'a', '2026-10-28')?.kind, '교육');
  assert.equal(absenceOn(absences, 'b', '2026-10-26'), undefined);
  assert.deepEqual(dateRange('2026-10-25', '2026-10-27'), ['2026-10-25', '2026-10-26', '2026-10-27']);
});

test('calendar counts distinct planned items in day, week and month', () => {
  const items = [{ id: 'p1', date: '2026-10-26' }, { id: 'p2', date: '2026-10-30' }, { id: 'p3', date: '2026-11-01' }];
  assert.deepEqual(visibleCalendarItems(items, 'day', '2026-10-26').map(item => item.id), ['p1']);
  assert.deepEqual(visibleCalendarItems(items, 'week', '2026-10-26').map(item => item.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(visibleCalendarItems(items, 'month', '2026-10-26').map(item => item.id), ['p1', 'p2']);
});

test('ongoing plan remains one item after its start date', () => {
  const plan = { id: 'p', date: '2026-10-26', ongoing: true };
  assert.deepEqual(visibleCalendarItems([plan], 'day', '2026-10-30').map(item => item.id), ['p']);
  assert.deepEqual(visibleCalendarItems([plan], 'month', '2026-11-10').map(item => item.id), ['p']);
  assert.deepEqual(visibleCalendarItems([plan], 'day', '2026-10-25'), []);
  assert.deepEqual(visibleCalendarItems([{ ...plan, completedDate: '2026-10-30' }], 'day', '2026-10-30'), []);
  assert.equal(calendarDates('week', '2026-11-01').length, 7);
  assert.equal(calendarDates('month', '2026-10-26').length, 31);
  assert.equal(seoulDate(new Date('2026-10-25T15:30:00Z')), '2026-10-26');
});

test('only status changes notify', () => {
  assert.equal(notificationForChange('배정', '작업 중', 'status'), true);
  assert.equal(notificationForChange('배정', '배정', 'status'), false);
  assert.equal(notificationForChange('배정', '완료', 'schedule'), false);
  assert.equal(notificationForChange('배정', '완료', 'assignee'), false);
});

test('one team finishing can leave overall request in progress', () => {
  assert.equal(combinedRequestStatus(['작업 중', '배정']), '작업 중');
  assert.equal(combinedRequestStatus(['작업 중', '완료']), '작업 중');
  assert.equal(combinedRequestStatus(['완료', '완료']), '완료');
});

test('request grouping uses request identity instead of recipient', () => {
  assert.deepEqual(linkedTeamsForRequest([{ team: 'teamA', requestId: 'request-1' }, { team: 'teamB', requestId: 'request-1' }, { team: 'teamC', requestId: 'request-2' }], 'request-1'), ['teamA', 'teamB']);
});
