import assert from 'node:assert/strict';
import test from 'node:test';
import { commandForRetry, clearCommandRetry } from './commandRetry.mjs';

test('unknown commands retain identity and reject changed input until resolved', () => {
  const pending={current:null};
  const command={type:'saveAbsence',expectedRevision:0,payload:{personRef:'synthetic-person',absenceType:'휴가',startDate:'2026-10-10',endDate:'2026-10-10'}};
  const first=commandForRetry(pending,command);
  const retry=commandForRetry(pending,command);
  assert.equal(retry.operationId,first.operationId,'LOST_RESPONSE_MUST_REUSE_OPERATION_ID');
  assert.deepEqual(retry,first,'LOST_RESPONSE_MUST_REUSE_COMMAND_INPUT_AND_VERSION');

  assert.throws(()=>commandForRetry(pending,{...command,expectedRevision:1}),/이전 저장 결과/,'UNKNOWN_SAVE_VERSION_MUST_STAY_FIXED');
  assert.throws(()=>commandForRetry(pending,{...command,payload:{...command.payload,endDate:'2026-10-11'}}),/이전 저장 결과/,'UNKNOWN_SAVE_INPUT_MUST_STAY_FIXED');
  assert.equal(commandForRetry(pending,command).operationId,first.operationId);

  clearCommandRetry(pending);
  assert.notEqual(commandForRetry(pending,command).operationId,first.operationId,'SUCCESS_MUST_CLEAR_PENDING_SUBMISSION');
});
