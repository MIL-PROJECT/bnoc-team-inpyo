export function isPlannedWorkInProgressOnDate(item, selectedDate) {
  return item.status === '진행 중' && Boolean(item.firstWorkDate) && item.firstWorkDate <= selectedDate;
}

export function isValidPlannedWorkCompletionDate(item, completedDate, today) {
  return Boolean(completedDate) && completedDate >= item.firstWorkDate && completedDate <= today;
}
