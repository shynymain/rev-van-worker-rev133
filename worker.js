// Rev133 Worker 修正版: 頭数は固定長禁止。馬番・馬名・単勝オッズの実データから確定。
// Cloudflare Workers 用。既存Workerへコピー、またはこのファイルで置き換え。
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function text(v) { return String(v ?? '').trim(); }
function num(v) { return text(v).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[^0-9]/g, ''); }
function cleanOdds(v) { return text(v).replace(/[円,，\s]/g, '').replace(/^？$/, ''); }
function officialFrame(noVal, headcountVal) {
  const n = Number(num(noVal));
  const hc = Number(num(headcountVal));
  if (!n || !hc) return '';
  if (hc <= 8) return String(Math.min(n, 8));
  const base = Math.floor(hc / 8);
  const rem = hc % 8;
  const counts = Array(8).fill(base);
  for (let i = 0; i < rem; i++) counts[7 - i]++;
  let start = 1;
  for (let f = 1; f <= 8; f++) {
    const end = start + counts[f - 1] - 1;
    if (n >= start && n <= end) return String(f);
    start = end + 1;
  }
  return '';
}
function calcPopularity(horses) {
  const odds = horses.map(h => Number(h.odds)).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  return horses.map(h => {
    const o = Number(h.odds);
    const rank = Number.isFinite(o) && o > 0 ? odds.findIndex(x => x === o) + 1 : 0;
    return { ...h, popularity: rank ? String(rank) : '' };
  });
}
function cleanHorse(h) {
  const c = { ...(h || {}) };
  c.no = num(c.no || c.number || c.horseNo);
  c.name = text(c.name || c.horseName).replace(/^？$/, '');
  c.last1 = text(c.last1).replace(/中止|取消|除外/g, '0');
  c.last2 = text(c.last2).replace(/中止|取消|除外/g, '0');
  c.last3 = text(c.last3).replace(/中止|取消|除外/g, '0');
  c.odds = cleanOdds(c.odds || c.winOdds);
  delete c.number; delete c.horseNo; delete c.horseName; delete c.winOdds;
  return c;
}
function sanitizeRace(r) {
  r = r || {};
  r.race = r.race || {};
  r.result = r.result || {};
  let horses = Array.isArray(r.horses) ? r.horses.map(cleanHorse) : [];

  // 固定18頭・固定15頭の穴埋めを完全禁止。実データがある行だけ残す。
  horses = horses.filter(h => h.no || h.name || h.last1 || h.last2 || h.last3 || h.odds);

  // 同一馬番は後勝ちで統合。
  const map = new Map();
  for (const h of horses) {
    const key = h.no || h.name;
    if (!key) continue;
    map.set(key, { ...(map.get(key) || {}), ...h });
  }
  horses = [...map.values()].sort((a, b) => (Number(a.no) || 999) - (Number(b.no) || 999));

  // 頭数は馬番・馬名・オッズの実件数から確定。race.headcountより実リストを優先。
  const headcount = horses.length;
  if (headcount) r.race.headcount = String(headcount);

  horses = horses.map(h => ({ ...h, frame: officialFrame(h.no, headcount) }));
  r.horses = calcPopularity(horses);

  for (const key of ['first', 'second', 'third']) {
    if (r.result[key + 'No']) r.result[key + 'Frame'] = officialFrame(r.result[key + 'No'], headcount);
  }
  return r;
}
function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid payload', races: [] };
  const races = Array.isArray(payload.races) ? payload.races.map(sanitizeRace) : [];
  return { ...payload, ok: payload.ok !== false, races };
}

async function handleOcr(request, env) {
  // 既存のOCR Workerに組み込む場合は、AI抽出後のJSONを sanitizePayload(aiJson) に通す。
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const payload = sanitizePayload(body);
  return json(payload);
}
async function handleSchedule(request, env) {
  let body = {};
  try { body = request.method === 'POST' ? await request.json() : {}; } catch (_) {}
  return json(sanitizePayload({ ok: true, races: body.races || [] }));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: JSON_HEADERS });
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return json({ ok: true, rev: '133-headcount-lock' });
    if (url.pathname === '/api/ocr') return handleOcr(request, env);
    if (url.pathname === '/api/schedule') return handleSchedule(request, env);
    return json({ ok: true, message: 'Rev133 Worker: /api/health /api/ocr /api/schedule' });
  }
};
