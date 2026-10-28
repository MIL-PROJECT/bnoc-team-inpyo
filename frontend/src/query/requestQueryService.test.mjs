import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStateStore } from '../store/sessionStateStore.mjs';
import { RequestQueryService } from './requestQueryService.mjs';
test('SR-DEMO-025,026,030: role scope and search stay separated', () => {
  const store = new SessionStateStore(), query = new RequestQueryService(store);
  assert.equal(query.getRequestList().some(r => r.requestNumber === '108'), false);
  store.switchActor('team-1');
  assert.equal(query.getRequestList().some(r => r.requestNumber === '102'), false);
  assert.deepEqual(query.searchRequests({ requestNumber: 'absent' }), []);
});

test('SR-DEMO-011,026: queries use public request numbers and hide internal ids', () => {
  const store = new SessionStateStore(), query = new RequestQueryService(store);
  const list = query.getRequestList();
  assert.ok(list.some(row => row.requestNumber === '101'));
  assert.ok(list.every(row => !('id' in row)));
  assert.equal(query.searchRequests({ requestNumber: '101' }).length, 1);
  assert.equal(query.getRequestDetail('101').requestNumber, '101');
});

test('SR-DEMO-030: caller input cannot spoof a more privileged actor', () => {
  const store = new SessionStateStore(), query = new RequestQueryService(store);
  assert.equal(query.getRequestDetail('108'), null);
  assert.equal(query.getRequestDetail({ role: 'bnoc' }, '108'), null);
});

test('request numbers keep numeric descending order despite new history and reuse filters before listing',()=>{
  const state={requests:['9','100','10'].map(requestNumber=>({id:requestNumber,requestNumber,requesterActorId:'owner',registeredBy:requestNumber==='100'?'bnoc':'owner',registeredAt:'2026-10-01T00:00:00Z'})),workItems:[],history:[{targetId:'9',at:'2027-01-01T00:00:00Z'}]};
  const query=new RequestQueryService({getActor:()=>({role:'requester',id:'owner'}),getSnapshot:()=>state});
  assert.deepEqual(query.getRequestList().map(row=>row.requestNumber),['100','10','9']);
  state.history.push({targetId:'10',at:'2028-01-01T00:00:00Z'});
  assert.deepEqual(query.getRequestList().map(row=>row.requestNumber),['100','10','9']);
  assert.deepEqual(query.getRequestList({reusableOnly:true}).map(row=>row.requestNumber),['10','9']);
});
