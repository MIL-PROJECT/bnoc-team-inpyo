import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneInputValue } from './phoneInput.mjs';

test('phone typing and pasted text retain only ASCII digits and hyphens', () => {
  assert.equal(phoneInputValue('군내 (02) 1234-5678 ext.9+'), '021234-56789');
  assert.equal(phoneInputValue('０１２-12한글\n34'), '-1234');
  assert.equal(phoneInputValue('000-1001'), '000-1001');
  assert.equal(phoneInputValue(''), '');
});
