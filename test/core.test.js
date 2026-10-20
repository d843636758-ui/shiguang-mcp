import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, normalizeGlucose } from '../src/db.js';
import { callTool, getToolList, handleMcp } from '../src/mcp.js';

test('converts mg/dL to mmol/L', () => {
  assert.equal(normalizeGlucose(180, 'mg/dL'), 10);
  assert.equal(normalizeGlucose(6.84, 'mmol/L'), 6.8);
});

test('exposes the meal and glucose tool set', () => {
  assert.deepEqual(getToolList().map((tool) => tool.name), [
    'list_meals', 'get_meal', 'get_meal_photo', 'save_meal_estimate',
    'list_glucose_readings', 'add_glucose_reading', 'get_meal_response', 'get_period_summary'
  ]);
});

test('stores and summarizes a meal response', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiguang-'));
  const db = openDatabase(dir);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO meals (id,eaten_at,title,note,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('meal-1', now, '测试餐', '', now, now);

  let result = callTool(db, dir, 'add_glucose_reading', { measured_at: now, value: 5.2, unit: 'mmol/L', timing: 'pre_meal', meal_id: 'meal-1' });
  assert.equal(result.isError, undefined);
  result = callTool(db, dir, 'add_glucose_reading', { measured_at: now, value: 7.4, unit: 'mmol/L', timing: 'post_1h', meal_id: 'meal-1' });
  assert.equal(result.isError, undefined);

  const response = callTool(db, dir, 'get_meal_response', { meal_id: 'meal-1' });
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.baseline_mmol, 5.2);
  assert.equal(payload.readings[1].change_from_pre_meal, 2.2);

  const initialized = handleMcp(db, dir, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initialized.result.serverInfo.name, 'shiguang-mcp');
  db.close(); rmSync(dir, { recursive: true, force: true });
});
