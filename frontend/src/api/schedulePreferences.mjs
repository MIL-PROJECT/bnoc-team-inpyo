export function schedulePreferenceInput(preferences = []) {
  const byRank = new Map((preferences ?? []).map(item => [item.rank, item]));
  const first = byRank.get(1), second = byRank.get(2);
  return {
    preference1Date: first?.date ?? '', preference1Period: first?.period ?? '',
    preference2Date: second?.date ?? '', preference2Period: second?.period ?? ''
  };
}

export function schedulePreferencesFromInput(input) {
  return [
    { rank: 1, date: input.preference1Date, period: input.preference1Period },
    { rank: 2, date: input.preference2Date, period: input.preference2Period }
  ].filter(item => item.date || item.period);
}
