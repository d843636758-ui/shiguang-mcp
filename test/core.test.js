import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, normalizeGlucose } from '../src/db.js';
import { callTool, getToolList, handleMcp } from '../src/mcp.js';
import sharp from 'sharp';

test('converts mg/dL to mmol/L', () => {
  assert.equal(normalizeGlucose(180, 'mg/dL'), 10);
  assert.equal(normalizeGlucose(6.84, 'mmol/L'), 6.8);
});

test('exposes the meal and glucose tool set', () => {
  assert.deepEqual(getToolList().map((tool) => tool.name), [
    'list_meals', 'get_meal', 'get_meal_photo', 'save_meal_estimate',
    'list_glucose_readings', 'add_glucose_reading', 'delete_glucose_reading', 'get_meal_response', 'get_period_summary'
  ]);
});

test('stores and summarizes a meal response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiguang-'));
  const db = openDatabase(dir);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO meals (id,eaten_at,title,note,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('meal-1', now, '测试餐', '', now, now);

  let result = await callTool(db, dir, 'add_glucose_reading', { measured_at: now, value: 5.2, unit: 'mmol/L', timing: 'pre_meal', meal_id: 'meal-1' });
  assert.equal(result.isError, undefined);
  result = await callTool(db, dir, 'add_glucose_reading', { measured_at: now, value: 7.4, unit: 'mmol/L', timing: 'post_1h', meal_id: 'meal-1' });
  assert.equal(result.isError, undefined);

  const response = await callTool(db, dir, 'get_meal_response', { meal_id: 'meal-1' });
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.baseline_mmol, 5.2);
  assert.equal(payload.readings[1].change_from_pre_meal, 2.2);

  const initialized = await handleMcp(db, dir, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initialized.result.serverInfo.name, 'shiguang-mcp');
  assert.equal(initialized.result.serverInfo.version, '0.2.0');
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test('creates controlled JPEG previews without changing PNG or JPEG originals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiguang-photo-'));
  const uploadDir = join(dir, 'uploads'); mkdirSync(uploadDir, { recursive: true });
  const db = openDatabase(dir); const now = new Date().toISOString();
  const fixtures = [
    { id: 'png-meal', file: 'original.png', mime: 'image/png', format: 'png' },
    { id: 'jpeg-meal', file: 'original.jpg', mime: 'image/jpeg', format: 'jpeg' }
  ];
  for (const fixture of fixtures) {
    let pipeline = sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 188, g: 92, b: 46 } } })[fixture.format]();
    if (fixture.format === 'jpeg') pipeline = pipeline.withMetadata({ orientation: 6 });
    const source = await pipeline.toBuffer();
    const path = join(uploadDir, fixture.file); writeFileSync(path, source); const before = readFileSync(path);
    db.prepare('INSERT INTO meals (id,eaten_at,title,note,photo_path,photo_mime,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(fixture.id, now, '测试餐照', '', fixture.file, fixture.mime, now, now);
    const result = await callTool(db, dir, 'get_meal_photo', { meal_id: fixture.id });
    const image = result.content.find((item) => item.type === 'image');
    const preview = Buffer.from(image.data, 'base64'); const metadata = await sharp(preview).metadata();
    assert.equal(image.mimeType, 'image/jpeg'); assert.equal(metadata.format, 'jpeg');
    assert.ok(preview[0] === 0xff && preview[1] === 0xd8); assert.ok(Math.max(metadata.width, metadata.height) <= 1024);
    assert.ok(preview.length <= 400 * 1024); assert.deepEqual(readFileSync(path), before);
    if (fixture.format === 'jpeg') assert.ok(metadata.height > metadata.width, 'EXIF orientation should be applied');
  }
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test('deletes one glucose reading without changing the meal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiguang-delete-')); const db = openDatabase(dir); const now = new Date().toISOString();
  db.prepare('INSERT INTO meals (id,eaten_at,title,note,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('meal-1', now, '测试餐', '', now, now);
  const added = await callTool(db, dir, 'add_glucose_reading', { measured_at: now, value: 6.2, timing: 'post_1h', meal_id: 'meal-1' });
  const id = JSON.parse(added.content[0].text).id;
  const deleted = await callTool(db, dir, 'delete_glucose_reading', { reading_id: id });
  assert.equal(JSON.parse(deleted.content[0].text).deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM glucose_readings').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM meals').get().count, 1);
  db.close(); rmSync(dir, { recursive: true, force: true });
});
