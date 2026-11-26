import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('resend cooldown: minutes setting, legacy hours, 15-minute default', () => {
  assert.equal(loadConfig({}).recovery.cooldownMinutes, 15);
  assert.equal(loadConfig({ RECOVERY_COOLDOWN_MINUTES: '15', RECOVERY_COOLDOWN_HOURS: '0' }).recovery.cooldownMinutes, 15);
  assert.equal(loadConfig({ RECOVERY_COOLDOWN_HOURS: '2' }).recovery.cooldownMinutes, 120);
  assert.equal(loadConfig({ RECOVERY_COOLDOWN_HOURS: '0' }).recovery.cooldownMinutes, 0);
  assert.equal(loadConfig({ RECOVERY_COOLDOWN_MINUTES: '0' }).recovery.cooldownMinutes, 0);
});
