const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { meals: [], readings: [], photoData: null };
const timingLabel = { fasting: '空腹', pre_meal: '餐前', post_1h: '餐后 1h', post_2h: '餐后 2h', bedtime: '睡前', other: '其他' };

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求没有成功');
  return data;
}

function localInputTime(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDay(value) {
  const date = new Date(value);
  return { day: String(date.getDate()).padStart(2, '0'), month: `${date.getMonth() + 1}月`, time: date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) };
}

function showToast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => node.classList.remove('show'), 2400);
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (id === 'mealDialog') dialog.elements.eaten_at.value = localInputTime();
  if (id === 'glucoseDialog') dialog.elements.measured_at.value = localInputTime();
  dialog.showModal();
}

async function compressPhoto(file) {
  if (!file) return null;
  if (file.size > 20 * 1024 * 1024) throw new Error('原图太大，请选一张小于 20MB 的照片');
  const bitmap = await createImageBitmap(file);
  const max = 1600; const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/webp', .84);
}

async function loadDashboard() {
  const data = await request('/api/dashboard');
  state.meals = data.meals; state.readings = data.readings;
  renderMeals(); renderChart(); renderMealOptions();
}

function renderMealOptions() {
  const select = $('#mealSelect');
  select.replaceChildren(new Option('不关联餐次', ''));
  state.meals.forEach((meal) => {
    const date = new Date(meal.eaten_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    select.add(new Option(`${date} · ${meal.title || '未命名的一餐'}`, meal.id));
  });
}

function renderMeals() {
  const list = $('#mealList'); const empty = $('#mealEmpty'); const template = $('#mealTemplate');
  list.replaceChildren(); empty.hidden = state.meals.length > 0;
  for (const meal of state.meals) {
    const fragment = template.content.cloneNode(true); const entry = $('.meal-entry', fragment); const d = formatDay(meal.eaten_at);
    $('.meal-date strong', entry).textContent = d.day; $('.meal-date span', entry).textContent = d.month;
    $('.meal-time', entry).textContent = d.time; $('h3', entry).textContent = meal.title || '未命名的一餐';
    const note = $('.meal-note', entry); note.textContent = meal.note || '这餐没有写备注。';
    const image = $('.meal-photo', entry); const placeholder = $('.photo-placeholder', entry);
    if (meal.photo_path) { image.src = `/api/photos/${meal.id}`; image.alt = `${meal.title || '餐食'}的照片`; placeholder.hidden = true; } else image.hidden = true;
    const estimateValue = $('.estimate-value', entry); const estimateMeta = $('.estimate-meta', entry);
    if (meal.calories_min != null) {
      estimateValue.textContent = `${meal.calories_min}–${meal.calories_max} kcal`;
      const macros = [meal.protein_g != null ? `蛋白质 ${meal.protein_g}g` : '', meal.carbs_g != null ? `碳水 ${meal.carbs_g}g` : '', meal.fat_g != null ? `脂肪 ${meal.fat_g}g` : ''].filter(Boolean);
      estimateMeta.textContent = `${macros.join(' · ') || '已完成区间估算'} · 可信度 ${meal.confidence === 'high' ? '较高' : meal.confidence === 'medium' ? '中等' : '较低'}`;
    } else { estimateValue.textContent = meal.photo_path ? '等待先生看看' : '尚未估算'; estimateMeta.textContent = meal.photo_path ? '在 ChatGPT 里让先生分析这餐照片' : '添加餐照后可以估算'; }
    const chips = $('.reading-chips', entry); const linked = state.readings.filter((r) => r.meal_id === meal.id).sort((a,b) => new Date(a.measured_at) - new Date(b.measured_at));
    if (!linked.length) chips.innerHTML = '<span class="reading-chip">还没有关联血糖</span>';
    else linked.forEach((reading) => { const chip = document.createElement('span'); chip.className = 'reading-chip'; chip.textContent = `${timingLabel[reading.timing]} ${reading.value_mmol} mmol/L`; chips.append(chip); });
    $('.delete-meal', entry).addEventListener('click', async () => {
      if (!confirm('要删除这一餐吗？关联的血糖不会删除，只会解除关联。')) return;
      await request(`/api/meals/${meal.id}`, { method: 'DELETE' }); showToast('这一页已经轻轻取下'); await loadDashboard();
    });
    list.append(fragment);
  }
}

function renderChart() {
  const svg = $('#glucoseChart'); const empty = $('#chartEmpty'); const readings = [...state.readings].sort((a,b) => new Date(a.measured_at) - new Date(b.measured_at)).slice(-24);
  $('#readingCount').textContent = readings.length ? `最近 ${readings.length} 次记录` : '等待第一笔记录';
  svg.replaceChildren(); empty.hidden = readings.length > 0; svg.hidden = !readings.length;
  if (!readings.length) return;
  const width = 800, height = 260, pad = { l: 54, r: 28, t: 26, b: 45 };
  const values = readings.map((r) => r.value_mmol); const min = Math.max(0, Math.floor(Math.min(...values) - 1)); const max = Math.ceil(Math.max(...values) + 1); const range = max - min || 1;
  const x = (i) => pad.l + i * ((width - pad.l - pad.r) / Math.max(readings.length - 1, 1)); const y = (v) => pad.t + (max - v) / range * (height - pad.t - pad.b);
  const ns = 'http://www.w3.org/2000/svg'; const add = (tag, attrs, text) => { const el = document.createElementNS(ns, tag); Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k,v)); if (text) el.textContent = text; svg.append(el); return el; };
  for (let i = 0; i <= 4; i++) { const value = min + range * i / 4; const yy = y(value); add('line', { x1: pad.l, x2: width-pad.r, y1: yy, y2: yy, stroke: 'rgba(39,53,47,.12)', 'stroke-width': 1 }); add('text', { x: pad.l-10, y: yy+4, 'text-anchor':'end', fill:'#657069', 'font-size':11 }, value.toFixed(1)); }
  if (readings.length === 1) add('line', { x1: pad.l, x2: width-pad.r, y1:y(values[0]), y2:y(values[0]), stroke:'#dc755f', 'stroke-width':2 });
  else add('path', { d: readings.map((r,i) => `${i?'L':'M'} ${x(i)} ${y(r.value_mmol)}`).join(' '), fill:'none', stroke:'#dc755f', 'stroke-width':3, 'stroke-linecap':'round', 'stroke-linejoin':'round' });
  readings.forEach((r,i) => { add('circle', { cx:x(i), cy:y(r.value_mmol), r:4.5, fill:'#f6f3eb', stroke:'#dc755f', 'stroke-width':2.5 }); if (i===0 || i===readings.length-1 || i % Math.ceil(readings.length/5)===0) add('text', { x:x(i), y:height-17, 'text-anchor':'middle', fill:'#657069', 'font-size':10 }, new Date(r.measured_at).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})); });
}

async function initialize() {
  $('#dateLine').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const session = await request('/api/session');
  $('#lockScreen').hidden = session.authenticated; $('#app').hidden = !session.authenticated;
  if (session.authenticated) await loadDashboard();
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget; const error = $('#loginError'); const button = $('button[type="submit"]', form);
  error.textContent = '';
  if (!form.password.value) { error.textContent = '先输入暗号，门才会打开。'; form.password.focus(); return; }
  button.disabled = true; button.textContent = '正在开门…'; form.setAttribute('aria-busy', 'true');
  try {
    await request('/api/login', { method:'POST', body:JSON.stringify({ password:form.password.value }) });
    $('#lockScreen').hidden = true; $('#app').hidden = false; await loadDashboard();
  } catch (cause) {
    error.textContent = cause.message;
  } finally {
    button.disabled = false; button.textContent = '推门进去'; form.removeAttribute('aria-busy');
  }
});

$('#logoutButton').addEventListener('click', async () => { await request('/api/logout', { method:'POST' }); location.reload(); });
$$('[data-open]').forEach((button) => button.addEventListener('click', () => openDialog(button.dataset.open)));
$$('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));

$('#mealPhoto').addEventListener('change', async (event) => {
  try { state.photoData = await compressPhoto(event.target.files[0]); const image = $('#photoPreview'); image.src = state.photoData; image.hidden = false; $('#photoPrompt').hidden = true; }
  catch (cause) { showToast(cause.message); event.target.value = ''; }
});

$('#mealForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const error = $('[data-form-error]', form); error.textContent = '';
  try {
    await request('/api/meals', { method:'POST', body:JSON.stringify({ title:form.title.value, eaten_at:new Date(form.eaten_at.value).toISOString(), note:form.note.value, photo:state.photoData }) });
    form.reset(); state.photoData = null; $('#photoPreview').hidden = true; $('#photoPrompt').hidden = false; form.closest('dialog').close(); showToast('这一餐已经收好'); await loadDashboard();
  } catch (cause) { error.textContent = cause.message; }
});

$('#glucoseForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const error = $('[data-form-error]', form); error.textContent = '';
  try {
    await request('/api/glucose', { method:'POST', body:JSON.stringify({ value:Number(form.value.value), unit:form.unit.value, timing:form.timing.value, measured_at:new Date(form.measured_at.value).toISOString(), meal_id:form.meal_id.value || null, note:form.note.value }) });
    form.reset(); form.closest('dialog').close(); showToast('数字已经记下'); await loadDashboard();
  } catch (cause) { error.textContent = cause.message; }
});

initialize().catch((cause) => { $('#loginError').textContent = cause.message; });
