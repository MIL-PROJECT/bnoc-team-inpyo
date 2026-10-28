export const absenceKinds = ['휴가', '외박', '출장', '파견', '교육', '기타'];

export function seoulDate(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function overlaps(start, end, day) {
  return Boolean(start && end && day && start <= day && day <= end);
}

export function absenceOn(absences, personId, day) {
  return absences.find(item => item.personId === personId && overlaps(item.start, item.end, day));
}

export function personnelCounts(people, absences, day) {
  const absent = people.filter(person => absenceOn(absences, person.id, day));
  return { total: people.length, absent: absent.length, present: people.length - absent.length };
}

export function dateRange(start, end) {
  if (!start || !end || end < start) return [];
  const days = [];
  const cursor = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  while (cursor <= last && days.length < 366) {
    days.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function visibleCalendarItems(items, view, day) {
  const reference = new Date(`${day}T12:00:00`);
  if (Number.isNaN(reference.getTime())) return [];
  const start = new Date(reference);
  const end = new Date(reference);
  if (view === 'week') {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    end.setTime(start.getTime()); end.setDate(end.getDate() + 6);
  } else if (view === 'month') {
    start.setDate(1); end.setMonth(end.getMonth() + 1, 0);
  }
  const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const from = iso(start), to = iso(end);
  return items.filter(item => item.ongoing ? item.date <= to && (!item.completedDate || item.completedDate > from) : item.date >= from && item.date <= to);
}

export function calendarDates(view, day) {
  const reference = new Date(`${day}T12:00:00`);
  if (Number.isNaN(reference.getTime())) return [];
  const start = new Date(reference);
  const end = new Date(reference);
  if (view === 'week') {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    end.setTime(start.getTime()); end.setDate(end.getDate() + 6);
  } else if (view === 'month') {
    start.setDate(1); end.setMonth(end.getMonth() + 1, 0);
  }
  const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return dateRange(iso(start), iso(end));
}

export function notificationForChange(before, after, kind) {
  return kind === 'status' && before !== after;
}

export function combinedRequestStatus(statuses) {
  if (!statuses.length) return '대기';
  if (statuses.includes('작업 중')) return '작업 중';
  if (statuses.every(status => status === '완료')) return '완료';
  return '배정';
}

export function linkedTeamsForRequest(contexts, requestRef) {
  return contexts.filter(item => item.requestId === requestRef).map(item => item.team);
}
