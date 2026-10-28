import test from 'node:test';
import assert from 'node:assert/strict';
import { localInputToUtc, localDateTimePartsToUtc, utcToLocalInput, calendarRange, moveDate, displayClock, displayDate } from './dateTime.mjs';

test('datetime inputs preserve Korea time while transmitting UTC instants', () => {
  assert.equal(localInputToUtc('2026-10-13T09:30'), '2026-10-13T00:30:00.000Z', 'SEOUL_INPUT_TO_UTC_REQUIRED');
  assert.equal(utcToLocalInput('2026-10-13T00:30:00Z'), '2026-10-13T09:30');
  assert.equal(localInputToUtc(''), undefined);
});

test('24-hour date and time parts validate strictly and preserve Seoul instants', () => {
  assert.equal(localDateTimePartsToUtc('2026-10-13', '00:00'), '2026-10-12T15:00:00.000Z');
  assert.equal(localDateTimePartsToUtc('2026-10-13', '23:59'), '2026-10-13T14:59:00.000Z');
  for (const [date, time] of [['2026-02-30','10:00'], ['2026-10-13','24:00'], ['2026-10-13','12:60'], ['2026-10-13','1:00'], ['','10:00'], ['2026-10-13','']]) {
    assert.equal(localDateTimePartsToUtc(date, time), undefined, `INVALID_DATE_TIME_ACCEPTED:${date}:${time}`);
  }
});

test('calendar uses inclusive Seoul start and exclusive end, Monday week and leap-month limits', () => {
  assert.deepEqual(calendarRange('2026-10-13', 'day'), { from: '2026-10-12T15:00:00.000Z', to: '2026-10-13T15:00:00.000Z', firstDate: '2026-10-13', lastDate: '2026-10-13' });
  const week = calendarRange('2026-10-18', 'week');
  assert.equal(week.firstDate, '2026-10-12', 'MONDAY_WEEK_REQUIRED');
  assert.equal(week.lastDate, '2026-10-18');
  const month = calendarRange('2028-02-15', 'month');
  assert.equal(month.firstDate, '2028-02-01');
  assert.equal(month.lastDate, '2028-02-29');
});

test('schedule cards can display the Seoul clock time without repeating the date heading', () => {
  assert.equal(displayClock('2026-10-20T01:00:00Z'), '10:00');
  assert.equal(displayClock('2026-10-20T15:00:00Z'), '00:00', 'MIDNIGHT_MUST_USE_24_HOUR_RANGE_START');
  assert.equal(displayClock(undefined), '미정');
});

test('date navigation crosses month, year, and leap-day boundaries', () => {
  assert.equal(moveDate('2026-12-31', 1), '2027-01-01');
  assert.equal(moveDate('2028-03-01', -1), '2028-02-29');
  assert.equal(moveDate('2028-02-29', 1), '2028-03-01');
});

test('list dates omit clock precision and preserve the Korea date boundary', () => {
  assert.equal(displayDate('2026-10-26T16:30:59Z'),'2026-10-27');
  assert.equal(displayDate('2026-10-26'),'2026-10-26');
  assert.equal(displayDate(undefined),'—');
  assert.equal(displayDate('invalid'),'날짜 확인 불가');
});
