import { absenceOn } from './mainFunctionsModel.mjs';

export type PersonCategory = '병' | '간부' | '군무원';
export type Person = { id: string; category: PersonCategory; rank: string; name: string; serviceNumber: string; phone: string; team: string; active?: boolean };
export type Absence = { id: string; personId: string; kind: string; start: string; end: string };
export type Duty = { id: string; date: string; slot: string; team: string; personId: string };
export type PersonnelSort = 'rank-desc' | 'rank-asc' | 'name';
export const personCategories: PersonCategory[] = ['병', '간부', '군무원'];
export const ranksByCategory: Record<PersonCategory, string[]> = {
  병: ['이병', '일병', '상병', '병장'],
  간부: ['하사', '중사', '상사', '원사', '준위', '소위', '중위', '대위', '소령', '중령', '대령', '준장', '소장', '중장', '대장'],
  군무원: ['9급', '8급', '7급', '6급', '5급', '4급', '3급', '2급', '1급']
};
const officerSeatCodes: Record<string,string> = {'당직사관':'duty_officer','A대대 일직사관':'communications_battalion_day_officer','B대대 일직사관':'battalion_b_day_officer'};
export const officerSlots = Object.keys(officerSeatCodes);
export const serverSeat = (label: string) => officerSeatCodes[label] ?? 'team_night';
export const uiSeat = (seat: string) => officerSlots.find(label => officerSeatCodes[label] === seat) ?? '야간 근무자';

export function dutyGroupsForDate(duties: Duty[], teams: string[], date: string) {
  const groups = new Map<string,{key:string;slot:string;team:string;people:Duty[]}>();
  const add = (slot: string, team: string) => {
    const key = `${slot}|${team}`;
    if (!groups.has(key)) groups.set(key,{key,slot,team,people:[]});
    return groups.get(key)!;
  };
  officerSlots.forEach(slot => add(slot,''));
  [...new Set(teams)].forEach(team => add('야간 근무자',team));
  duties.filter(item => item.date === date).forEach(item => {
    const group = add(item.slot,item.team);
    if (!group.people.some(person => person.personId === item.personId)) group.people.push(item);
  });
  return [...groups.values()];
}

function validIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  return year >= 1000 && value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
}

// 군인사법 제3조. 군무원 직급은 군 계급과 등치하지 않는다.
const militaryRanks = ['이병','일병','상병','병장','하사','중사','상사','원사','준위','소위','중위','대위','소령','중령','대령','준장','소장','중장','대장','원수'];
const rankAliases: Record<string,string> = {이등병:'이병',일등병:'일병',상등병:'상병'};
export function personnelCategories(order: PersonnelSort = 'rank-desc'): PersonCategory[] {
  return order === 'rank-asc' ? ['병','간부','군무원'] : ['간부','병','군무원'];
}
export function comparePersonnelRank(a: {category:PersonCategory;rank?:string|null}, b: {category:PersonCategory;rank?:string|null}, order: PersonnelSort = 'rank-desc') {
  const categories = personnelCategories(order);
  const category = categories.indexOf(a.category) - categories.indexOf(b.category);
  if (category || order === 'name') return category;
  const value = (person: typeof a) => {
    const rank = (person.rank || '').normalize('NFC').trim();
    return (person.category === '군무원' ? ranksByCategory.군무원 : militaryRanks).indexOf(rankAliases[rank] || rank);
  };
  const first = value(a), second = value(b);
  if (first < 0 || second < 0) return first < 0 && second < 0 ? 0 : first < 0 ? 1 : -1;
  return order === 'rank-asc' ? first - second : second - first;
}
export function sortPersonnel(people: Person[], order: PersonnelSort = 'rank-desc'): Person[] {
  return [...people].sort((a,b) => comparePersonnelRank(a,b,order) || a.name.localeCompare(b.name,'ko') || a.id.localeCompare(b.id));
}

export function dutyCandidates(people: Person[], role: string, team: string): Person[] {
  return sortPersonnel(people.filter(person => role === 'bnoc' ? person.category === '간부' : role === 'team' && person.team === team));
}

export function applyDutySelection(duties: Duty[], people: Person[], absences: Absence[], input: {
  role: string; team: string; month: string; dates: string[]; slot: string; personIds: string[]; append: boolean;
}): Duty[] {
  const { role, team, month, slot, append } = input;
  const dates = [...new Set(input.dates)];
  const personIds = [...new Set(input.personIds)];
  if (!['bnoc', 'team'].includes(role) || (role === 'team' ? slot !== '야간 근무자' : !officerSlots.includes(slot))) throw new Error('편성 권한을 확인하세요.');
  if (!dates.length || dates.some(date => !validIsoDate(date) || date.slice(0, 7) !== month)) throw new Error('같은 달의 날짜를 선택하세요.');
  if (append && !personIds.length) throw new Error('추가할 인원을 선택하세요.');
  const scope = role === 'team' ? team : '';
  const candidates = new Map(dutyCandidates(people, role, team).map(person => [person.id, person]));
  for (const id of personIds) {
    const person = candidates.get(id);
    if (!person) throw new Error('편성할 수 없는 인원이 포함되어 있습니다.');
    for (const date of dates) {
      const retained = duties.some(duty => duty.date === date && duty.slot === slot && duty.team === scope && duty.personId === id);
      if (person.active === false && !retained) throw new Error('편성할 수 없는 인원이 포함되어 있습니다.');
      if (!retained && absenceOn(absences, id, date)) throw new Error(`${person.name} · ${date} 부재와 겹칩니다.`);
    }
  }
  const selectedDates = new Set(dates);
  const relevant = (duty: Duty) => duty.team === scope && duty.slot === slot && selectedDates.has(duty.date);
  const result = duties.filter(duty => append || !relevant(duty));
  for (const date of dates) for (const personId of personIds) {
    if (result.some(duty => duty.date === date && duty.slot === slot && duty.team === scope && duty.personId === personId)) continue;
    result.push({ id: JSON.stringify([scope, slot, date, personId]), date, slot, team: scope, personId });
  }
  return result;
}

export function appendDutyText(duties: Duty[], people: Person[], absences: Absence[], input: {
  role: string; team: string; month: string; slot: string; text: string;
}): { duties: Duty[]; added: number; alreadyScheduled: number } {
  const { role, team, month, slot, text } = input;
  if (!['bnoc', 'team'].includes(role) || (role === 'team' ? slot !== '야간 근무자' : !officerSlots.includes(slot))) throw new Error('편성 권한을 확인하세요.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('대상 월을 확인하세요.');
  const lines = text.split(/\r?\n/).map((value, index) => ({ value: value.trim(), line: index + 1 })).filter(item => item.value);
  if (!lines.length) throw new Error('근무자 목록을 입력하세요.');
  const scope = role === 'team' ? team : '';
  const candidates = dutyCandidates(people, role, team).filter(person => person.active !== false);
  const assigned = new Set(duties.filter(item => item.team === scope && item.slot === slot).map(item => JSON.stringify([item.date, item.personId])));
  const additions: Duty[] = [];
  let alreadyScheduled = 0;
  for (const { value, line } of lines) {
    const fields = value.split(/\s+/);
    if (fields.length < 3 || !/^\d{8}$/.test(fields[0])) throw new Error(`${line}행: YYYYMMDD 계급 이름 형식으로 입력하세요.`);
    const date = `${fields[0].slice(0, 4)}-${fields[0].slice(4, 6)}-${fields[0].slice(6, 8)}`;
    const rank = fields[1];
    const name = fields.slice(2).join(' ');
    if (!validIsoDate(date)) throw new Error(`${line}행: 실제 날짜를 입력하세요.`);
    if (date.slice(0, 7) !== month) throw new Error(`${line}행: 선택한 월의 날짜를 입력하세요.`);
    const matches = candidates.filter(person => person.rank === rank && person.name === name);
    if (!matches.length) throw new Error(`${line}행: 편성 가능한 인원을 명부에서 찾지 못했습니다 (${rank} ${name}).`);
    if (matches.length > 1) throw new Error(`${line}행: 같은 계급·이름의 인원이 여러 명입니다 (${rank} ${name}).`);
    const person = matches[0];
    const absence = absenceOn(absences, person.id, date);
    if (absence) throw new Error(`${line}행: ${rank} ${name}은 ${absence.kind} 기간입니다.`);
    const key = JSON.stringify([date, person.id]);
    if (assigned.has(key)) { alreadyScheduled++; continue; }
    assigned.add(key);
    additions.push({ id: JSON.stringify([scope, slot, date, person.id]), date, slot, team: scope, personId: person.id });
  }
  return { duties: additions.length ? [...duties, ...additions] : duties, added: additions.length, alreadyScheduled };
}
