const hourKey = (instant) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(instant));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}`;
};

function dateInSeoul(instant) { return hourKey(instant).slice(0, 10); }

function moveDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function calendarHoursForInterval(interval, day) {
  const start = Date.parse(interval.startsAt), end = Date.parse(interval.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return Array.from({ length: 24 }, (_, hour) => hour).filter(hour => {
    const slotStart = Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00+09:00`);
    const slotEnd = slotStart + 60 * 60 * 1000;
    return start < slotEnd && end > slotStart;
  });
}

export function scheduleSlotsFromIntervals(intervals = []) {
  const slots = new Set();
  for (const interval of intervals) {
    const start = Date.parse(interval.startsAt), end = Date.parse(interval.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const lastDay = dateInSeoul(end - 1);
    for (let day = dateInSeoul(start); day <= lastDay; day = moveDay(day)) {
      for (const hour of calendarHoursForInterval(interval, day)) slots.add(`${day}T${String(hour).padStart(2, '0')}`);
    }
  }
  return [...slots].sort();
}

export function scheduleSlotsForRange(day, startHour, endHour) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const parsedDay = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) return [];
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) return [];
  if (!Number.isInteger(endHour) || endHour < 1 || endHour > 24 || endHour <= startHour) return [];
  return Array.from({ length: endHour - startHour }, (_, index) => `${day}T${String(startHour + index).padStart(2, '0')}`);
}

export function removeScheduleIntervalSlots(slotKeys = [], intervals = [], removeIndex) {
  const removed = intervals[removeIndex];
  if (!removed) return [...new Set(slotKeys)];
  const removedSlots = new Set(scheduleSlotsFromIntervals([removed]));
  const retainedSlots = new Set(intervals
    .filter((_, index) => index !== removeIndex)
    .flatMap(interval => scheduleSlotsFromIntervals([interval])));
  return [...new Set(slotKeys)].filter(slot => !removedSlots.has(slot) || retainedSlots.has(slot));
}

function utcForSeoulHour(key) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/.exec(key);
  if (!match || Number(match[2]) > 23) return undefined;
  const date = new Date(`${match[1]}T${match[2]}:00:00+09:00`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function scheduleIntervalsFromSlots(slotKeys = [], preservedIntervals = []) {
  const selected = new Set(slotKeys);
  const unique = [...selected].sort((a, b) => (utcForSeoulHour(a) ?? '').localeCompare(utcForSeoulHour(b) ?? ''));
  const preserved = preservedIntervals.filter(interval => {
    const covered = scheduleSlotsFromIntervals([interval]);
    return covered.length > 0 && covered.every(slot => selected.has(slot));
  });
  const retainedSlots = new Set(preserved.flatMap(interval => scheduleSlotsFromIntervals([interval])));
  const generatedSlots = unique.filter(slot => !retainedSlots.has(slot));
  const groups = [];
  for (const key of generatedSlots) {
    const startsAt = utcForSeoulHour(key);
    if (!startsAt) continue;
    const date = key.slice(0, 10), hour = Number(key.slice(11));
    const previous = groups.at(-1);
    if (previous && previous.date === date && previous.lastHour + 1 === hour) {
      previous.endsAt = new Date(Date.parse(startsAt) + 60 * 60 * 1000).toISOString();
      previous.lastHour = hour;
    } else {
      groups.push({ date, lastHour: hour, startsAt, endsAt: new Date(Date.parse(startsAt) + 60 * 60 * 1000).toISOString() });
    }
  }
  return [...preserved, ...groups.map(({ startsAt, endsAt }) => ({ startsAt, endsAt }))]
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

const clockTime = value => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));

export function displayInterval(interval) {
  return `${clockTime(interval.startsAt)}–${clockTime(interval.endsAt)}`;
}

export function displayScheduleRange(interval) {
  const startDate = dateInSeoul(interval.startsAt);
  const endDate = dateInSeoul(interval.endsAt);
  if (endDate === startDate) return `${startDate} · ${displayInterval(interval)}`;
  const endTime = clockTime(interval.endsAt);
  if (endTime === '00:00' && endDate === moveDay(startDate)) return `${startDate} · ${clockTime(interval.startsAt)}–24:00`;
  return `${startDate} · ${clockTime(interval.startsAt)}–${endDate} ${endTime}`;
}

export function calendarPlacementsForPeriod(entries = [], completedRecords = [], dates = []) {
  if (!dates.length) return [];
  const firstDate = dates[0], lastDate = dates.at(-1);
  const periodStart = Date.parse(`${firstDate}T00:00:00+09:00`);
  const periodEnd = Date.parse(`${moveDay(lastDate)}T00:00:00+09:00`);
  const completedWorkNumbers = new Set(completedRecords.map(item => item.workNumber));
  const workByNumber = new Map();
  for (const item of entries) workByNumber.set(item.workNumber, item);
  for (const item of completedRecords) workByNumber.set(item.workNumber, item);
  const placements = [];

  for (const item of workByNumber.values()) {
    if (item.origin === 'after-action') {
      const sortAt = Date.parse(item.actualStartedAt);
      if (Number.isFinite(sortAt) && sortAt >= periodStart && sortAt < periodEnd) {
        const key = hourKey(sortAt);
        placements.push({ item, kind: 'after-action', date: key.slice(0, 10), hour: Number(key.slice(11)), sortAt, intervals: [] });
      }
      continue;
    }

    const intervals = [...new Map((item.scheduleIntervals ?? [])
      .filter(interval => {
        const start = Date.parse(interval.startsAt), end = Date.parse(interval.endsAt);
        return Number.isFinite(start) && Number.isFinite(end) && start < periodEnd && end > periodStart && end > start;
      })
      .map(interval => [`${interval.startsAt}\u0000${interval.endsAt}`, interval])).values()]
      .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));

    if (intervals.length) {
      const sortAt = Math.min(...intervals.map(interval => Math.max(Date.parse(interval.startsAt), periodStart)));
      const key = hourKey(sortAt);
      placements.push({ item, kind: completedWorkNumbers.has(item.workNumber) ? 'completed-assigned' : 'scheduled', date: key.slice(0, 10), hour: Number(key.slice(11)), sortAt, intervals });
      continue;
    }

    if (!completedWorkNumbers.has(item.workNumber)) continue;
    const sortAt = Date.parse(item.completedAt);
    if (Number.isFinite(sortAt) && sortAt >= periodStart && sortAt < periodEnd) {
      const key = hourKey(sortAt);
      placements.push({ item, kind: 'completed-assigned', date: key.slice(0, 10), hour: Number(key.slice(11)), sortAt, intervals: [] });
    }
  }

  return placements.sort((left, right) => left.sortAt - right.sortAt || String(left.item.workNumber).localeCompare(String(right.item.workNumber), undefined, { numeric: true }));
}
