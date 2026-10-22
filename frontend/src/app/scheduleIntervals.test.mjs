import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarHoursForInterval, calendarPlacementsForPeriod, displayInterval, displayScheduleRange, removeScheduleIntervalSlots, scheduleIntervalsFromSlots, scheduleSlotsForRange, scheduleSlotsFromIntervals } from './scheduleIntervals.mjs';

test('hour choices cover the full Seoul day and merge adjacent hours only within the same date', () => {
  const intervals = scheduleIntervalsFromSlots([
    '2026-10-22T23', '2026-10-22T00', '2026-10-22T01', '2026-10-22T04', '2026-10-23T00'
  ]);
  assert.deepEqual(intervals, [
    { startsAt: '2026-10-21T15:00:00.000Z', endsAt: '2026-10-21T17:00:00.000Z' },
    { startsAt: '2026-10-21T19:00:00.000Z', endsAt: '2026-10-21T20:00:00.000Z' },
    { startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T15:00:00.000Z' },
    { startsAt: '2026-10-22T15:00:00.000Z', endsAt: '2026-10-22T16:00:00.000Z' }
  ]);
  assert.deepEqual(scheduleSlotsFromIntervals(intervals), [
    '2026-10-22T00', '2026-10-22T01', '2026-10-22T04', '2026-10-22T23', '2026-10-23T00'
  ]);
});

test('selected schedule range uses a 00 to 24 hour clock', () => {
  assert.equal(displayInterval({ startsAt: '2026-10-21T15:00:00Z', endsAt: '2026-10-21T17:00:00Z' }), '00:00–02:00');
});

test('range editor accepts whole-hour ranges through 24:00 and labels midnight as the selected day end', () => {
  assert.deepEqual(scheduleSlotsForRange('2026-10-20', 0, 1), ['2026-10-20T00']);
  assert.deepEqual(scheduleSlotsForRange('2026-10-20', 10, 12), ['2026-10-20T10', '2026-10-20T11']);
  assert.deepEqual(scheduleSlotsForRange('2026-10-21', 0, 1), ['2026-10-21T00']);
  const lastHour = scheduleIntervalsFromSlots(scheduleSlotsForRange('2026-10-20', 23, 24))[0];
  assert.deepEqual(lastHour, { startsAt: '2026-10-20T14:00:00.000Z', endsAt: '2026-10-20T15:00:00.000Z' });
  assert.equal(displayScheduleRange(lastHour), '2026-10-20 · 23:00–24:00');
  assert.equal(displayScheduleRange({ startsAt: '2026-10-20T14:30:00Z', endsAt: '2026-10-20T15:30:00Z' }), '2026-10-20 · 23:30–2026-10-21 00:30');
  assert.deepEqual(scheduleSlotsForRange('2026-10-20', 23, 23), []);
  assert.deepEqual(scheduleSlotsForRange('2026-10-20', 23, 25), []);
  assert.deepEqual(scheduleSlotsForRange('2026-02-30', 0, 1), []);
});

test('removing one minute-precision range keeps another interval that shares a covered hour', () => {
  const intervals = [
    { startsAt: '2026-10-20T01:07:00Z', endsAt: '2026-10-20T02:07:00Z' },
    { startsAt: '2026-10-20T02:07:00Z', endsAt: '2026-10-20T03:07:00Z' }
  ];
  const slots = scheduleSlotsFromIntervals(intervals);
  const remaining = removeScheduleIntervalSlots(slots, intervals, 0);
  assert.deepEqual(remaining, ['2026-10-20T11', '2026-10-20T12']);
  assert.deepEqual(scheduleIntervalsFromSlots(remaining, intervals), [intervals[1]]);
});

test('existing minute-level intervals remain exact when unrelated hourly choices are added', () => {
  const legacy = { startsAt: '2026-10-20T01:07:00Z', endsAt: '2026-10-20T02:07:00Z' };
  const selected = scheduleSlotsFromIntervals([legacy]);
  assert.deepEqual(selected, ['2026-10-20T10', '2026-10-20T11']);
  assert.deepEqual(scheduleIntervalsFromSlots([...selected, '2026-10-20T12'], [legacy]), [
    legacy,
    { startsAt: '2026-10-20T03:00:00.000Z', endsAt: '2026-10-20T04:00:00.000Z' }
  ], 'adding a separate choice must not round a preserved legacy start');
  assert.deepEqual(scheduleIntervalsFromSlots(['2026-10-20T10'], [legacy]), [
    { startsAt: '2026-10-20T01:00:00.000Z', endsAt: '2026-10-20T02:00:00.000Z' }
  ], 'changing one of the legacy covered hours explicitly replaces the old interval');
});

test('calendar interval appears in every overlapping hour and across a Seoul midnight', () => {
  assert.deepEqual(calendarHoursForInterval({ startsAt: '2026-10-20T01:00:00Z', endsAt: '2026-10-20T03:00:00Z' }, '2026-10-20'), [10, 11]);
  const legacyCrossing = { startsAt: '2026-10-20T14:30:00Z', endsAt: '2026-10-20T15:30:00Z' };
  assert.deepEqual(calendarHoursForInterval(legacyCrossing, '2026-10-20'), [23]);
  assert.deepEqual(calendarHoursForInterval(legacyCrossing, '2026-10-21'), [0]);
  assert.deepEqual(calendarHoursForInterval({ startsAt: '2026-10-20T01:00:00Z', endsAt: '2026-10-20T02:00:00Z' }, '2026-10-20'), [10], 'the end is exclusive');
});

test('period calendar placements show each work once at its earliest visible interval start', () => {
  const entries = [
    { workNumber: '102-1', origin: 'assigned', scheduleIntervals: [
      { startsAt: '2026-10-20T01:00:00Z', endsAt: '2026-10-20T03:00:00Z' },
      { startsAt: '2026-10-20T05:00:00Z', endsAt: '2026-10-20T06:00:00Z' }
    ] },
    { workNumber: '103-1', origin: 'assigned', scheduleIntervals: [{ startsAt: '2026-10-20T01:00:00Z', endsAt: '2026-10-20T02:00:00Z' }] },
    { workNumber: '100-1', origin: 'assigned', scheduleIntervals: [{ startsAt: '2026-10-20T01:30:00Z', endsAt: '2026-10-20T02:30:00Z' }] },
    { workNumber: '101-1', origin: 'assigned', scheduleIntervals: [{ startsAt: '2026-10-19T14:00:00Z', endsAt: '2026-10-20T01:00:00Z' }] },
    { workNumber: '104-1', origin: 'assigned', scheduleIntervals: [{ startsAt: '2026-10-21T15:00:00Z', endsAt: '2026-10-21T16:00:00Z' }] }
  ];
  const completed = [
    { workNumber: '105-1', origin: 'assigned', scheduleIntervals: [], completedAt: '2026-10-20T06:30:00Z' },
    { workNumber: '106-1', origin: 'after-action', actualStartedAt: '2026-10-20T07:05:00Z', completedAt: '2026-10-20T08:00:00Z' }
  ];

  const placements = calendarPlacementsForPeriod(entries, completed, ['2026-10-20', '2026-10-21']);
  assert.deepEqual(placements.map(({ item, kind, date, hour }) => [item.workNumber, kind, date, hour]), [
    ['101-1', 'scheduled', '2026-10-20', 0],
    ['102-1', 'scheduled', '2026-10-20', 10],
    ['103-1', 'scheduled', '2026-10-20', 10],
    ['100-1', 'scheduled', '2026-10-20', 10],
    ['105-1', 'completed-assigned', '2026-10-20', 15],
    ['106-1', 'after-action', '2026-10-20', 16]
  ]);
  assert.equal(placements.find(placement => placement.item.workNumber === '102-1').intervals.length, 2, 'one card keeps every in-period interval');
  assert.deepEqual(placements.find(placement => placement.item.workNumber === '101-1').intervals, [entries[3].scheduleIntervals[0]], 'a crossing interval retains its original start');
});
