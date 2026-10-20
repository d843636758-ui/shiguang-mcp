import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'shiguang.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meals (
      id TEXT PRIMARY KEY,
      eaten_at TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      photo_path TEXT,
      photo_mime TEXT,
      calories_min INTEGER,
      calories_max INTEGER,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      confidence TEXT CHECK (confidence IN ('low','medium','high')),
      estimate_note TEXT,
      estimated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meals_eaten_at_idx ON meals(eaten_at DESC);

    CREATE TABLE IF NOT EXISTS glucose_readings (
      id TEXT PRIMARY KEY,
      measured_at TEXT NOT NULL,
      value_mmol REAL NOT NULL CHECK (value_mmol > 0 AND value_mmol < 60),
      timing TEXT NOT NULL CHECK (timing IN ('fasting','pre_meal','post_1h','post_2h','bedtime','other')),
      meal_id TEXT REFERENCES meals(id) ON DELETE SET NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS glucose_measured_at_idx ON glucose_readings(measured_at DESC);
    CREATE INDEX IF NOT EXISTS glucose_meal_id_idx ON glucose_readings(meal_id);
  `);
  return db;
}

export function normalizeGlucose(value, unit = 'mmol/L') {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('血糖值不是有效数字');
  const mmol = unit.toLowerCase().startsWith('mg') ? number / 18 : number;
  if (mmol <= 0 || mmol >= 60) throw new Error('血糖值超出可记录范围');
  return Math.round(mmol * 10) / 10;
}

export function mealWithReadings(db, id) {
  const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(id);
  if (!meal) return null;
  const readings = db.prepare('SELECT * FROM glucose_readings WHERE meal_id = ? ORDER BY measured_at ASC').all(id);
  return { ...meal, readings };
}

export function listMeals(db, { from, to, limit = 30 } = {}) {
  const clauses = [];
  const values = [];
  if (from) { clauses.push('eaten_at >= ?'); values.push(from); }
  if (to) { clauses.push('eaten_at <= ?'); values.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(Math.min(Math.max(Number(limit) || 30, 1), 100));
  return db.prepare(`SELECT * FROM meals ${where} ORDER BY eaten_at DESC LIMIT ?`).all(...values);
}

export function listReadings(db, { from, to, mealId, limit = 100 } = {}) {
  const clauses = [];
  const values = [];
  if (from) { clauses.push('measured_at >= ?'); values.push(from); }
  if (to) { clauses.push('measured_at <= ?'); values.push(to); }
  if (mealId) { clauses.push('meal_id = ?'); values.push(mealId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  return db.prepare(`SELECT * FROM glucose_readings ${where} ORDER BY measured_at DESC LIMIT ?`).all(...values);
}
