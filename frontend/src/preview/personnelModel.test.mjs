import test from 'node:test';
import assert from 'node:assert/strict';
import { sortPersonnel, dutyCandidates, applyDutySelection, officerSlots, serverSeat, uiSeat, dutyGroupsForDate } from './personnelModel.ts';
const person = (id, category, rank, name = id, team = '유선반') => ({ id, category, rank, name, team, serviceNumber: id, phone: '' });
const people = [person('private', '병', '이병', '김전장'), person('corporal', '병', '상병', '박정체'), person('officer', '간부', '소위'), person('sergeant', '간부', '중사'), person('civilian', '군무원', '7급'), person('other', '병', '병장', '타반', '무선반')];
const input = { role: 'bnoc', team: '', month: '2026-10', dates: ['2026-10-01'], slot: '당직사관', personIds: ['officer'], append: false };
test('officer seats expose duty officer and independent battalion A and B labels', () => {
  assert.deepEqual(officerSlots, ['당직사관','A대대 일직사관','B대대 일직사관']);
});
test('saving battalion B preserves battalion A and other dates and rejects team writers', () => {
  const earlier = [{id:'a',date:'2026-10-01',slot:'A대대 일직사관',team:'',personId:'sergeant'}, {id:'next',date:'2026-10-02',slot:'B대대 일직사관',team:'',personId:'sergeant'}];
  const original = structuredClone(earlier);
  const saved = applyDutySelection(earlier,people,[],{...input,slot:'B대대 일직사관'});
  assert.deepEqual(saved.filter(row=>row.date!=='2026-10-01'||row.slot!=='B대대 일직사관'),original);
  assert.equal(saved.find(row=>row.date==='2026-10-01'&&row.slot==='B대대 일직사관').personId,'officer');
  assert.deepEqual(earlier,original);
  assert.throws(()=>applyDutySelection(saved,people,[],{...input,role:'team',team:'유선반',slot:'B대대 일직사관'}),/편성 권한/);
});
test('roster groups categories then orders ranks and names without changing source', () => {
  const original = structuredClone(people);
  assert.deepEqual(sortPersonnel(people).map(item => item.id), ['officer', 'sergeant', 'other', 'corporal', 'private', 'civilian']);
  assert.deepEqual(sortPersonnel(people, 'rank-asc').filter(item => item.category === '병').map(item => item.id), ['private', 'corporal', 'other']);
  assert.deepEqual(sortPersonnel(people, 'name').filter(item => item.category === '병').map(item => item.name), ['김전장', '박정체', '타반']);
  assert.deepEqual(people, original);
});
test('officer seats exclude soldiers and civilians; night duty only exposes own team', () => {
  assert.deepEqual(dutyCandidates(people, 'bnoc', '').map(item => item.id), ['officer', 'sergeant']);
  assert.ok(dutyCandidates(people, 'team', '유선반').every(item => item.team === '유선반'));
  assert.deepEqual(dutyCandidates(people, 'requester', '유선반'), []);
  for (const id of ['private', 'civilian']) assert.throws(() => applyDutySelection([], people, [], { ...input, personIds: [id] }), /편성할 수 없는 인원/);
  assert.throws(() => applyDutySelection([], people, [], { ...input, role: 'team', team: '유선반', slot: '야간 근무자', personIds: ['other'] }), /편성할 수 없는 인원/);
  assert.throws(() => applyDutySelection([], people, [], { ...input, role: 'team', team: '유선반' }), /편성 권한/);
});
test('inactive members cannot be added but an existing assignment remains editable', () => {
  const inactive = people.map(item => item.id === 'officer' ? { ...item, active: false } : item);
  assert.throws(() => applyDutySelection([], inactive, [], input), /편성할 수 없는 인원/);
  const existing = [{ id: 'old', date: '2026-10-01', slot: '당직사관', team: '', personId: 'officer' }];
  const retained = applyDutySelection(existing, inactive, [], { ...input, personIds: ['officer'] });
  assert.deepEqual(retained.map(item => [item.date, item.slot, item.team, item.personId]), existing.map(item => [item.date, item.slot, item.team, item.personId]));
});
test('multi-person save, day editing and clearing preserve other seats and dates', () => {
  const earlier = [{ id: 'keep', date: '2026-10-02', slot: '당직사관', team: '', personId: 'sergeant' }, { id: 'seat', date: '2026-10-01', slot: 'A대대 일직사관', team: '', personId: 'sergeant' }];
  const saved = applyDutySelection(earlier, people, [], { ...input, personIds: ['officer', 'sergeant'] });
  assert.equal(saved.length, 4);
  const edited = applyDutySelection(saved, people, [], input);
  assert.equal(edited.length, 3);
  assert.deepEqual(edited.filter(item => item.slot === '당직사관' && item.date === '2026-10-01').map(item => item.personId), ['officer']);
  assert.deepEqual(applyDutySelection(edited, people, [], { ...input, personIds: [] }), earlier);
  assert.equal(earlier.length, 2);
});
test('batch adds only to selected dates and preserves existing people without duplicates', () => {
  const earlier = [{ id: 'existing', date: '2026-10-01', slot: '당직사관', team: '', personId: 'sergeant' }, { id: 'keep', date: '2026-10-03', slot: '당직사관', team: '', personId: 'sergeant' }];
  const batch = { ...input, dates: ['2026-10-01', '2026-10-02'], append: true };
  const saved = applyDutySelection(earlier, people, [], batch);
  assert.equal(saved.length, 4);
  assert.equal(saved.filter(item => item.date === '2026-10-01').length, 2);
  assert.deepEqual(applyDutySelection(saved, people, [], batch), saved);
  assert.deepEqual(saved.filter(item => item.date === '2026-10-03'), [earlier[1]]);
});
test('absence on any selected day blocks atomic save; existing conflict is preserved', () => {
  const earlier = [{ id: 'existing', date: '2026-10-01', slot: '당직사관', team: '', personId: 'officer' }];
  const absences = [{ id: 'a', personId: 'officer', kind: '휴가', start: '2026-10-01', end: '2026-10-02' }];
  assert.doesNotThrow(() => applyDutySelection(earlier, people, absences, { ...input, dates: ['2026-10-01'], append: true }), 'an existing conflict remains visible and can be retained for correction');
  assert.throws(() => applyDutySelection(earlier, people, absences, { ...input, dates: ['2026-10-03', '2026-10-02'], append: true }), /부재와 겹칩니다/);
  assert.equal(earlier.length, 1);
  assert.equal(applyDutySelection(earlier, people, absences, { ...input, personIds: ['sergeant'], append: true }).length, 2);
  assert.deepEqual(applyDutySelection(earlier, people, absences, { ...input, personIds: [] }), []);
});
test('invalid month, invalid date and role cannot write a schedule', () => {
  for (const dates of [[], ['2026-11-01'], ['2026-10-32'], ['2026-02-30']]) assert.throws(() => applyDutySelection([], people, [], { ...input, dates }), /같은 달/);
  assert.throws(() => applyDutySelection([], people, [], { ...input, role: 'requester' }), /편성 권한/);
});

// User's 2026-10-27 correction: compare actual rank before any presentation grouping.
test('whole military rank order and aliases keep positions distinct from ranks', () => {
  const ranks = ['원수','대장','중장','소장','준장','대령','중령','소령','대위','중위','소위','준위','원사','상사','중사','하사','병장','상병','일병','이병'];
  const rows = ranks.map((rank,index) => person(String(index),index < 16 ? '간부' : '병',rank));
  assert.deepEqual(sortPersonnel([...rows].reverse()).map(row=>row.rank),ranks);
  assert.deepEqual(sortPersonnel(rows,'rank-asc').map(row=>row.rank),[...ranks].reverse());
  const unknown = person('unknown','간부','반장');
  assert.equal(sortPersonnel([unknown,...rows])[16].id,'unknown');
  for (const [long,short] of [['상등병','상병'],['일등병','일병'],['이등병','이병']]) {
    const pair=[person('b','병',long,'같은 이름'),person('a','병',short,'같은 이름')];
    assert.deepEqual(sortPersonnel(pair).map(row=>row.id),['a','b']);
  }
});


test('battalion A retains its legacy server key and B roundtrips to a different key', () => {
  assert.equal(serverSeat('A대대 일직사관'),'communications_battalion_day_officer');
  assert.equal(uiSeat('communications_battalion_day_officer'),'A대대 일직사관');
  assert.equal(serverSeat('B대대 일직사관'),'battalion_b_day_officer');
  assert.equal(uiSeat('battalion_b_day_officer'),'B대대 일직사관');
});
test('empty duty groups retain all officer and team seats without inventing assignments', () => {
  const teams=['무선반','유선반'];
  const empty=dutyGroupsForDate([],teams,'2026-10-01');
  assert.deepEqual(empty.map(g=>[g.slot,g.team]),[['당직사관',''],['A대대 일직사관',''],['B대대 일직사관',''],['야간 근무자','무선반'],['야간 근무자','유선반']]);
  assert(empty.every(group=>group.people.length===0));
  const rows=[{id:'a',date:'2026-10-01',slot:'A대대 일직사관',team:'',personId:'officer'},{id:'b',date:'2026-10-02',slot:'B대대 일직사관',team:'',personId:'sergeant'}];
  const original=structuredClone(rows),groups=dutyGroupsForDate(rows,teams,'2026-10-01');
  assert.equal(groups.length,5);assert.equal(groups[1].people[0].personId,'officer');assert.equal(groups[2].people.length,0);assert.deepEqual(rows,original);
});
