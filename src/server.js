import { createServer } from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { openDatabase, listMeals, listReadings, mealWithReadings, normalizeGlucose } from './db.js';
import { handleMcp } from './mcp.js';

const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
const publicDir = join(process.cwd(), 'public');
const appPassword = process.env.APP_PASSWORD || '';
const sessionSecret = process.env.SESSION_SECRET || '';
const mcpToken = process.env.MCP_TOKEN || '';
const publicOrigin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;

if (appPassword.length < 10 || sessionSecret.length < 32 || mcpToken.length < 24) {
  console.error('APP_PASSWORD(>=10), SESSION_SECRET(>=32) 与 MCP_TOKEN(>=24) 必须配置。');
  process.exit(1);
}

const db = openDatabase(dataDir);
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const timingValues = ['fasting', 'pre_meal', 'post_1h', 'post_2h', 'bedtime', 'other'];

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

async function bodyJson(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 格式无效'), { status: 400 }); }
}

function passwordMatches(candidate) {
  const expected = scryptSync(appPassword, 'shiguang-owner-v1', 32);
  const actual = scryptSync(String(candidate || ''), 'shiguang-owner-v1', 32);
  return timingSafeEqual(expected, actual);
}

function signSession(expiry) {
  const payload = `owner.${expiry}`;
  const signature = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function hasSession(req) {
  const cookie = String(req.headers.cookie || '').split(';').map((v) => v.trim()).find((v) => v.startsWith('shiguang_session='));
  if (!cookie) return false;
  const token = cookie.slice('shiguang_session='.length);
  const [role, expiry, signature] = token.split('.');
  if (role !== 'owner' || !expiry || !signature || Number(expiry) < Date.now()) return false;
  const expected = createHmac('sha256', sessionSecret).update(`${role}.${expiry}`).digest('base64url');
  const a = Buffer.from(signature); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireSession(req, res) {
  if (hasSession(req)) return true;
  json(res, 401, { error: '请先解锁食光曲线' });
  return false;
}

function isoOrNow(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error('时间格式无效'), { status: 400 });
  return date.toISOString();
}

function parseDataImage(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw Object.assign(new Error('仅支持 JPEG、PNG 或 WebP 照片'), { status: 400 });
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw Object.assign(new Error('照片需小于 8MB'), { status: 413 });
  const mime = match[1];
  const valid = (mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) ||
    (mime === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
  if (!valid) throw Object.assign(new Error('照片内容校验失败'), { status: 400 });
  return { bytes, mime, extension: mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] };
}

async function api(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await bodyJson(req, 4096);
    if (!passwordMatches(body.password)) return json(res, 401, { error: '暗号不对，再想一想' });
    const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    return json(res, 200, { ok: true }, { 'Set-Cookie': `shiguang_session=${signSession(expiry)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=2592000` });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'shiguang_session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0' });
  }
  if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { authenticated: hasSession(req) });
  if (!requireSession(req, res)) return;

  if (url.pathname === '/api/dashboard' && req.method === 'GET') {
    return json(res, 200, { meals: listMeals(db, { limit: 30 }), readings: listReadings(db, { limit: 120 }) });
  }
  if (url.pathname === '/api/meals' && req.method === 'POST') {
    const body = await bodyJson(req);
    const id = randomUUID();
    const now = new Date().toISOString();
    let photoPath = null; let photoMime = null;
    if (body.photo) {
      const image = parseDataImage(body.photo);
      photoPath = `${id}.${image.extension}`;
      photoMime = image.mime;
      await writeFile(join(dataDir, 'uploads', photoPath), image.bytes, { flag: 'wx' });
    }
    try {
      db.prepare('INSERT INTO meals (id, eaten_at, title, note, photo_path, photo_mime, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, isoOrNow(body.eaten_at), String(body.title || '').slice(0, 100), String(body.note || '').slice(0, 1000), photoPath, photoMime, now, now
      );
    } catch (cause) {
      if (photoPath) await unlink(join(dataDir, 'uploads', photoPath)).catch(() => {});
      throw cause;
    }
    return json(res, 201, mealWithReadings(db, id));
  }
  if (url.pathname === '/api/glucose' && req.method === 'POST') {
    const body = await bodyJson(req, 64 * 1024);
    if (!timingValues.includes(body.timing)) throw Object.assign(new Error('请选择测量时点'), { status: 400 });
    if (body.meal_id && !db.prepare('SELECT 1 FROM meals WHERE id=?').get(body.meal_id)) throw Object.assign(new Error('关联餐次不存在'), { status: 400 });
    const id = randomUUID();
    db.prepare('INSERT INTO glucose_readings (id, measured_at, value_mmol, timing, meal_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, isoOrNow(body.measured_at), normalizeGlucose(body.value, body.unit), body.timing, body.meal_id || null, String(body.note || '').slice(0, 500), new Date().toISOString()
    );
    return json(res, 201, db.prepare('SELECT * FROM glucose_readings WHERE id=?').get(id));
  }
  if (url.pathname.startsWith('/api/photos/') && req.method === 'GET') {
    const id = url.pathname.slice('/api/photos/'.length);
    const meal = db.prepare('SELECT photo_path, photo_mime FROM meals WHERE id=?').get(id);
    if (!meal?.photo_path) return json(res, 404, { error: '没有找到照片' });
    const bytes = await readFile(join(dataDir, 'uploads', meal.photo_path));
    res.writeHead(200, { 'Content-Type': meal.photo_mime, 'Cache-Control': 'private, max-age=3600', 'Content-Length': bytes.length });
    return res.end(bytes);
  }
  if (url.pathname.startsWith('/api/meals/') && req.method === 'DELETE') {
    const id = url.pathname.slice('/api/meals/'.length);
    const meal = db.prepare('SELECT photo_path FROM meals WHERE id=?').get(id);
    if (!meal) return json(res, 404, { error: '没有找到餐次' });
    db.prepare('DELETE FROM meals WHERE id=?').run(id);
    if (meal.photo_path) await unlink(join(dataDir, 'uploads', meal.photo_path)).catch(() => {});
    return json(res, 200, { deleted: true });
  }
  return json(res, 404, { error: '接口不存在' });
}

async function serveStatic(req, res, url) {
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = join(publicDir, safe);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) return json(res, 404, { error: '页面不存在' });
  const bytes = await readFile(filePath);
  res.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream', 'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
  res.end(bytes);
}

const server = createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url || '/', publicOrigin);
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, service: 'shiguang-mcp' });
    if (url.pathname.startsWith('/mcp/')) {
      const supplied = decodeURIComponent(url.pathname.slice('/mcp/'.length));
      const a = Buffer.from(supplied); const b = Buffer.from(mcpToken);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return json(res, 404, { error: 'Not found' });
      if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      const result = handleMcp(db, dataDir, await bodyJson(req, 2 * 1024 * 1024));
      if (result === null) { res.writeHead(202); return res.end(); }
      return json(res, 200, result, { 'Access-Control-Allow-Origin': 'https://chatgpt.com' });
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return await serveStatic(req, res, url);
  } catch (cause) {
    console.error(cause);
    return json(res, cause?.status || 500, { error: cause instanceof Error ? cause.message : '服务器开小差了' });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`食光曲线已在 ${publicOrigin} 启动`));

