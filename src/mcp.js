import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listMeals, listReadings, mealWithReadings, normalizeGlucose } from './db.js';

const timingValues = ['fasting', 'pre_meal', 'post_1h', 'post_2h', 'bedtime', 'other'];

const tools = [
  {
    name: 'list_meals',
    description: '列出餐食记录与已有热量估算。用于寻找待分析的餐照或回顾一段时间的饮食。',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'ISO 时间下界' }, to: { type: 'string', description: 'ISO 时间上界' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } } }
  },
  {
    name: 'get_meal',
    description: '获取一餐的文字信息、热量估算及关联的餐前/餐后血糖。',
    inputSchema: { type: 'object', properties: { meal_id: { type: 'string' } }, required: ['meal_id'] }
  },
  {
    name: 'get_meal_photo',
    description: '读取一餐的照片供视觉分析。照片属于敏感健康数据，只在用户请求分析对应餐次时调用。',
    inputSchema: { type: 'object', properties: { meal_id: { type: 'string' } }, required: ['meal_id'] }
  },
  {
    name: 'save_meal_estimate',
    description: '把基于照片与用户描述的热量区间、宏量营养素近似值和不确定性说明保存到餐次。必须明确这是估算而非精确测量。',
    inputSchema: {
      type: 'object',
      properties: {
        meal_id: { type: 'string' }, calories_min: { type: 'integer', minimum: 0, maximum: 10000 }, calories_max: { type: 'integer', minimum: 0, maximum: 10000 },
        protein_g: { type: 'number', minimum: 0, maximum: 1000 }, carbs_g: { type: 'number', minimum: 0, maximum: 2000 }, fat_g: { type: 'number', minimum: 0, maximum: 1000 },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] }, note: { type: 'string', maxLength: 1200 }
      },
      required: ['meal_id', 'calories_min', 'calories_max', 'confidence', 'note']
    }
  },
  {
    name: 'list_glucose_readings',
    description: '列出血糖记录时间线。数值统一以 mmol/L 返回，并保留与餐次的关联。',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, meal_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } } }
  },
  {
    name: 'add_glucose_reading',
    description: '按用户明确提供的数据补记一条血糖；不要猜测或从照片推断血糖数值。',
    inputSchema: {
      type: 'object', properties: {
        measured_at: { type: 'string', description: 'ISO 时间' }, value: { type: 'number' }, unit: { type: 'string', enum: ['mmol/L', 'mg/dL'], default: 'mmol/L' },
        timing: { type: 'string', enum: timingValues }, meal_id: { type: 'string' }, note: { type: 'string', maxLength: 500 }
      }, required: ['measured_at', 'value', 'timing']
    }
  },
  {
    name: 'get_meal_response',
    description: '返回某餐全部关联血糖并计算相对餐前值的变化，供趋势讨论使用，不作诊断。',
    inputSchema: { type: 'object', properties: { meal_id: { type: 'string' } }, required: ['meal_id'] }
  },
  {
    name: 'get_period_summary',
    description: '汇总指定时段餐次、已估热量与血糖分布，用于发现可进一步讨论的模式；结果不是医疗诊断。',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }
  }
];

function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function error(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function getToolList() { return tools; }

export function callTool(db, dataDir, name, args = {}) {
  try {
    if (name === 'list_meals') return text(listMeals(db, args));
    if (name === 'get_meal') {
      const meal = mealWithReadings(db, args.meal_id);
      return meal ? text(meal) : error('未找到这条餐食记录');
    }
    if (name === 'get_meal_photo') {
      const meal = db.prepare('SELECT id, title, eaten_at, note, photo_path, photo_mime FROM meals WHERE id = ?').get(args.meal_id);
      if (!meal) return error('未找到这条餐食记录');
      if (!meal.photo_path) return error('这条餐食没有照片');
      const data = readFileSync(join(dataDir, 'uploads', meal.photo_path)).toString('base64');
      return { content: [
        { type: 'text', text: `餐次 ${meal.id}，时间 ${meal.eaten_at}，标题：${meal.title || '未命名'}。用户备注：${meal.note || '无'}。请以区间表达热量估算，并说明份量、烹饪油和不可见配料带来的不确定性。` },
        { type: 'image', data, mimeType: meal.photo_mime || 'image/jpeg' }
      ] };
    }
    if (name === 'save_meal_estimate') {
      if (Number(args.calories_min) > Number(args.calories_max)) return error('热量下限不能高于上限');
      const now = new Date().toISOString();
      const result = db.prepare(`UPDATE meals SET calories_min=?, calories_max=?, protein_g=?, carbs_g=?, fat_g=?, confidence=?, estimate_note=?, estimated_at=?, updated_at=? WHERE id=?`).run(
        args.calories_min, args.calories_max, args.protein_g ?? null, args.carbs_g ?? null, args.fat_g ?? null, args.confidence, String(args.note || ''), now, now, args.meal_id
      );
      return result.changes ? text({ saved: true, meal_id: args.meal_id }) : error('未找到这条餐食记录');
    }
    if (name === 'list_glucose_readings') return text(listReadings(db, { from: args.from, to: args.to, mealId: args.meal_id, limit: args.limit }));
    if (name === 'add_glucose_reading') {
      if (!timingValues.includes(args.timing)) return error('无效的测量时点');
      if (args.meal_id && !db.prepare('SELECT 1 FROM meals WHERE id=?').get(args.meal_id)) return error('关联餐次不存在');
      const id = randomUUID();
      const valueMmol = normalizeGlucose(args.value, args.unit);
      db.prepare('INSERT INTO glucose_readings (id, measured_at, value_mmol, timing, meal_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, args.measured_at, valueMmol, args.timing, args.meal_id || null, String(args.note || ''), new Date().toISOString()
      );
      return text({ saved: true, id, value_mmol: valueMmol });
    }
    if (name === 'get_meal_response') {
      const meal = mealWithReadings(db, args.meal_id);
      if (!meal) return error('未找到这条餐食记录');
      const baseline = meal.readings.find((r) => r.timing === 'pre_meal')?.value_mmol ?? null;
      const readings = meal.readings.map((r) => ({ ...r, change_from_pre_meal: baseline == null ? null : Math.round((r.value_mmol - baseline) * 10) / 10 }));
      return text({ meal_id: meal.id, title: meal.title, eaten_at: meal.eaten_at, baseline_mmol: baseline, readings, caution: '仅作个人趋势整理，不用于诊断或调整用药。' });
    }
    if (name === 'get_period_summary') {
      const meals = listMeals(db, { from: args.from, to: args.to, limit: 100 });
      const readings = listReadings(db, { from: args.from, to: args.to, limit: 500 });
      const values = readings.map((r) => r.value_mmol);
      const average = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : null;
      const estimated = meals.filter((m) => m.calories_min != null && m.calories_max != null);
      return text({
        period: { from: args.from, to: args.to }, meal_count: meals.length, estimated_meal_count: estimated.length,
        estimated_calories_midpoint_total: estimated.reduce((sum, m) => sum + (m.calories_min + m.calories_max) / 2, 0),
        glucose: { count: readings.length, average_mmol: average, minimum_mmol: values.length ? Math.min(...values) : null, maximum_mmol: values.length ? Math.max(...values) : null },
        caution: '汇总仅用于记录与模式讨论，不是诊断结论。'
      });
    }
    return error(`未知工具：${name}`);
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : '工具执行失败');
  }
}

export function handleMcp(db, dataDir, body) {
  const id = body?.id ?? null;
  const response = (result) => ({ jsonrpc: '2.0', id, result });
  if (body?.method === 'initialize') return response({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'shiguang-mcp', version: '0.1.0' } });
  if (body?.method === 'ping') return response({});
  if (body?.method === 'tools/list') return response({ tools });
  if (body?.method === 'tools/call') return response(callTool(db, dataDir, body.params?.name, body.params?.arguments || {}));
  if (body?.method?.startsWith('notifications/')) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}
