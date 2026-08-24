const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const SESSION_COOKIE = 'cs_marketing_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const AUTH_HEADER_PREFIX = 'Bearer ';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, ctx, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: err?.message || 'Internal error' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncConfigured(env));
  }
};

async function handleApi(request, env, ctx, url) {
  if (request.method === 'POST' && url.pathname === '/api/auth/login') return login(request, env, url);
  if (request.method === 'GET' && url.pathname === '/api/auth/session') return sessionStatus(request, env);
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') return logout(url);

  const session = await verifySession(request, env);
  if (!session) return json({ error: 'Требуется авторизация' }, 401);

  await ensureExtendedSchema(env);

  if (request.method === 'GET' && url.pathname === '/api/status') return status(env);
  if (request.method === 'GET' && url.pathname === '/api/dashboard') return dashboard(env);
  if (request.method === 'POST' && url.pathname === '/api/import') return importRows(request, env);
  const m = url.pathname.match(/^\/api\/sync\/(metrika|webmaster|direct|vkads|unisender|maxsocial)$/);
  if (request.method === 'POST' && m) {
    try {
      const result = await syncSource(m[1], env);
      return json(result, 200);
    } catch (err) {
      await logSync(env, m[1], 'error', err?.message || 'Ошибка синхронизации').catch(() => {});
      return json({ error: err?.message || 'Ошибка синхронизации' }, 500);
    }
  }
  return json({ error: 'Not found' }, 404);
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

/* -------------------- AUTH -------------------- */

async function login(request, env, url) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: 'Авторизация на сервере ещё не настроена. Добавьте ADMIN_PASSWORD и SESSION_SECRET в Cloudflare Secrets.' }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Некорректный запрос' }, 400); }
  const expectedUser = String(env.ADMIN_USERNAME || 'admin');
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  const userOk = await secureTextEqual(username, expectedUser);
  const passOk = await secureTextEqual(password, String(env.ADMIN_PASSWORD));
  if (!userOk || !passOk) return json({ error: 'Неверный логин или пароль' }, 401);

  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await createSessionToken(expectedUser, expires, env.SESSION_SECRET);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  const cookie = `${SESSION_COOKIE}=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
  return json({ authenticated: true, user: expectedUser, token }, 200, { 'set-cookie': cookie });
}

async function sessionStatus(request, env) {
  const result = await verifySessionDetailed(request, env);
  if (!result.ok) return json({ authenticated: false, reason: result.reason }, 401);
  return json({ authenticated: true, user: result.user, expires: result.exp });
}

function logout(url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return json({ authenticated: false }, 200, { 'set-cookie': `${SESSION_COOKIE}=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0` });
}

async function verifySession(request, env) {
  const result = await verifySessionDetailed(request, env);
  return result.ok ? { user: result.user, exp: result.exp } : null;
}

async function verifySessionDetailed(request, env) {
  if (!env.SESSION_SECRET) return { ok: false, reason: 'SESSION_SECRET отсутствует' };
  const cookieToken = readCookie(request.headers.get('cookie') || '', SESSION_COOKIE);
  const auth = request.headers.get('authorization') || '';
  const bearerToken = auth.startsWith(AUTH_HEADER_PREFIX) ? auth.slice(AUTH_HEADER_PREFIX.length).trim() : '';
  const token = bearerToken || cookieToken;
  if (!token) return { ok: false, reason: 'Сессионный токен не передан' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'Неверный формат сессии' };
  const [userEncoded, expRaw, signature] = parts;
  let user;
  try { user = decodeURIComponent(userEncoded); } catch { return { ok: false, reason: 'Не удалось прочитать пользователя' }; }
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'Неверный срок сессии' };
  if (exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'Сессия истекла' };

  const expectedUser = String(env.ADMIN_USERNAME || 'admin');
  if (!(await secureTextEqual(user, expectedUser))) return { ok: false, reason: 'Пользователь сессии не совпадает' };
  const expectedSignature = await sessionSignature(user, exp, env.SESSION_SECRET);
  if (!(await secureTextEqual(signature, expectedSignature))) return { ok: false, reason: 'Подпись сессии не прошла проверку' };
  return { ok: true, user, exp };
}

async function createSessionToken(user, exp, secret) {
  const signature = await sessionSignature(user, exp, secret);
  return `${encodeURIComponent(user)}.${exp}.${signature}`;
}
async function sessionSignature(user, exp, secret) { return sha256Hex(`${String(user)}|${String(exp)}|${String(secret)}`); }
async function sha256Hex(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
async function secureTextEqual(a, b) {
  const encoder = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b)))
  ]);
  const aa = new Uint8Array(ha), bb = new Uint8Array(hb);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}
function readCookie(header, name) {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/* -------------------- SCHEMA -------------------- */

let schemaPromise;
async function ensureExtendedSchema(env) {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const creates = [
      `CREATE TABLE IF NOT EXISTS daily_site_metrics (date TEXT PRIMARY KEY, visits INTEGER DEFAULT 0, users INTEGER DEFAULT 0, pageviews INTEGER DEFAULT 0, bounce_rate REAL DEFAULT 0, depth REAL DEFAULT 0, duration REAL DEFAULT 0, conversions REAL DEFAULT 0, new_visitors REAL DEFAULT 0, email_clicks REAL DEFAULT 0, form_submits REAL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS site_period_summary (period_days INTEGER PRIMARY KEY, visits REAL DEFAULT 0, users REAL DEFAULT 0, pageviews REAL DEFAULT 0, bounce_rate REAL DEFAULT 0, depth REAL DEFAULT 0, duration REAL DEFAULT 0, new_visitors REAL DEFAULT 0, conversions REAL DEFAULT 0, email_clicks REAL DEFAULT 0, form_submits REAL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS traffic_sources (period_key TEXT NOT NULL, name TEXT NOT NULL, visits INTEGER DEFAULT 0, users INTEGER DEFAULT 0, bounce REAL DEFAULT 0, conversions REAL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(period_key,name))`,
      `CREATE TABLE IF NOT EXISTS landing_pages (period_key TEXT NOT NULL, page TEXT NOT NULL, title TEXT, visits INTEGER DEFAULT 0, users INTEGER DEFAULT 0, bounce REAL DEFAULT 0, depth REAL DEFAULT 0, duration REAL DEFAULT 0, conversions REAL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(period_key,page))`,
      `CREATE TABLE IF NOT EXISTS seo_queries (query TEXT PRIMARY KEY, shows REAL DEFAULT 0, clicks REAL DEFAULT 0, ctr REAL DEFAULT 0, position REAL DEFAULT 0, delta REAL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS sync_log (source TEXT PRIMARY KEY, last_sync TEXT, status TEXT, message TEXT)`,
      `CREATE TABLE IF NOT EXISTS resolved_integrations (source TEXT PRIMARY KEY, external_id TEXT, label TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS search_engines (period_key TEXT NOT NULL, name TEXT NOT NULL, visits REAL DEFAULT 0, users REAL DEFAULT 0, PRIMARY KEY(period_key,name))`,
      `CREATE TABLE IF NOT EXISTS device_stats (period_key TEXT NOT NULL, name TEXT NOT NULL, visits REAL DEFAULT 0, users REAL DEFAULT 0, PRIMARY KEY(period_key,name))`,
      `CREATE TABLE IF NOT EXISTS region_stats (period_key TEXT NOT NULL, name TEXT NOT NULL, visits REAL DEFAULT 0, users REAL DEFAULT 0, PRIMARY KEY(period_key,name))`,
      `CREATE TABLE IF NOT EXISTS metrika_goals (period_key TEXT NOT NULL, goal_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT, category TEXT, reaches REAL DEFAULT 0, visits REAL DEFAULT 0, conversion_rate REAL DEFAULT 0, PRIMARY KEY(period_key,goal_id))`,
      `CREATE TABLE IF NOT EXISTS seo_summary (id INTEGER PRIMARY KEY CHECK(id=1), sqi REAL DEFAULT 0, excluded_pages REAL DEFAULT 0, searchable_pages REAL DEFAULT 0, fatal REAL DEFAULT 0, critical REAL DEFAULT 0, possible REAL DEFAULT 0, recommendation REAL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS seo_index_history (date TEXT PRIMARY KEY, pages_in_search REAL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS seo_problems (code TEXT PRIMARY KEY, severity TEXT, state TEXT, last_update TEXT)`,
      `CREATE TABLE IF NOT EXISTS ad_campaign_meta (channel TEXT NOT NULL, campaign_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT, native_state TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(channel,campaign_id))`,
      `CREATE TABLE IF NOT EXISTS ad_campaign_daily (channel TEXT NOT NULL, campaign_id TEXT NOT NULL, name TEXT NOT NULL, date TEXT NOT NULL, impressions REAL DEFAULT 0, clicks REAL DEFAULT 0, spend REAL DEFAULT 0, conversions REAL DEFAULT 0, PRIMARY KEY(channel,campaign_id,date))`,
      `CREATE TABLE IF NOT EXISTS social_posts (channel TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL, reach REAL DEFAULT 0, views REAL DEFAULT 0, reactions REAL DEFAULT 0, comments REAL DEFAULT 0, shares REAL DEFAULT 0, clicks REAL DEFAULT 0, followers REAL DEFAULT 0, followers_delta REAL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(channel,title,date))`,
      `CREATE TABLE IF NOT EXISTS email_campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL, date TEXT, status TEXT, sent REAL DEFAULT 0, delivered REAL DEFAULT 0, opened REAL DEFAULT 0, clicked REAL DEFAULT 0, unsub REAL DEFAULT 0, spam REAL DEFAULT 0, errors REAL DEFAULT 0, report_url TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`
    ];
    for (const sql of creates) await env.DB.prepare(sql).run();
    const alters = [
      `ALTER TABLE daily_site_metrics ADD COLUMN new_visitors REAL DEFAULT 0`,
      `ALTER TABLE daily_site_metrics ADD COLUMN email_clicks REAL DEFAULT 0`,
      `ALTER TABLE daily_site_metrics ADD COLUMN form_submits REAL DEFAULT 0`,
      `ALTER TABLE traffic_sources ADD COLUMN users INTEGER DEFAULT 0`,
      `ALTER TABLE traffic_sources ADD COLUMN bounce REAL DEFAULT 0`,
      `ALTER TABLE landing_pages ADD COLUMN users INTEGER DEFAULT 0`,
      `ALTER TABLE landing_pages ADD COLUMN duration REAL DEFAULT 0`
    ];
    for (const sql of alters) await env.DB.prepare(sql).run().catch(() => {});
  })();
  try { await schemaPromise; } catch (e) { schemaPromise = null; throw e; }
}

/* -------------------- API DATA -------------------- */

async function status(env) {
  const [logs, resolvedRows] = await Promise.all([
    env.DB.prepare('SELECT source,last_sync,status,message FROM sync_log').all().catch(() => ({ results: [] })),
    env.DB.prepare('SELECT source,external_id,label,updated_at FROM resolved_integrations').all().catch(() => ({ results: [] }))
  ]);
  const map = Object.fromEntries((logs.results || []).map(x => [x.source, x]));
  const resolved = Object.fromEntries((resolvedRows.results || []).map(x => [x.source, x]));
  const item = (source, configured, missing, mode = 'api') => ({
    connected: Boolean(configured), configured: Boolean(configured), missing, mode,
    lastSync: map[source]?.last_sync || null, status: map[source]?.status || null, message: map[source]?.message || null,
    resolvedId: resolved[source]?.external_id || null, resolvedLabel: resolved[source]?.label || null
  });
  const yandexBase = Boolean(env.YANDEX_TOKEN);
  const metrikaTarget = Boolean(env.METRIKA_COUNTER_ID || env.SITE_URL);
  const webmasterTarget = Boolean(env.WEBMASTER_HOST_ID || env.SITE_URL);
  const vkAdsConfigured = Boolean(env.VK_ADS_TOKEN || (env.VK_ADS_CLIENT_ID && env.VK_ADS_CLIENT_SECRET));
  const integrations = {
    metrika: item('metrika', yandexBase && metrikaTarget, [!env.YANDEX_TOKEN && 'YANDEX_TOKEN', !metrikaTarget && 'SITE_URL или METRIKA_COUNTER_ID'].filter(Boolean)),
    webmaster: item('webmaster', yandexBase && webmasterTarget, [!env.YANDEX_TOKEN && 'YANDEX_TOKEN', !webmasterTarget && 'SITE_URL или WEBMASTER_HOST_ID'].filter(Boolean)),
    direct: item('direct', Boolean(env.DIRECT_TOKEN), [!env.DIRECT_TOKEN && 'DIRECT_TOKEN'].filter(Boolean)),
    vkads: item('vkads', vkAdsConfigured, [!env.VK_ADS_TOKEN && !env.VK_ADS_CLIENT_ID && 'VK_ADS_CLIENT_ID', !env.VK_ADS_TOKEN && !env.VK_ADS_CLIENT_SECRET && 'VK_ADS_CLIENT_SECRET'].filter(Boolean)),
    unisender: item('unisender', Boolean(env.UNISENDER_API_KEY), [!env.UNISENDER_API_KEY && 'UNISENDER_API_KEY'].filter(Boolean)),
    vksocial: item('vksocial', false, [], 'manual'),
    telegram: item('telegram', false, [], 'mtproto'),
    dzenads: item('dzenads', false, [], 'manual'),
    dzensocial: item('dzensocial', false, [], 'manual'),
    maxsocial: item('maxsocial', Boolean(env.MAX_BOT_TOKEN && env.MAX_CHANNEL_ID), [!env.MAX_BOT_TOKEN && 'MAX_BOT_TOKEN', !env.MAX_CHANNEL_ID && 'MAX_CHANNEL_ID'].filter(Boolean), 'api')
  };
  return json({
    mode: Object.values(integrations).some(x => x.connected) ? 'live' : 'empty', integrations,
    siteUrl: env.SITE_URL || null,
    metrikaCounterId: env.METRIKA_COUNTER_ID || resolved.metrika?.external_id || null,
    webmasterHostId: env.WEBMASTER_HOST_ID || resolved.webmaster?.external_id || null
  });
}

async function dashboard(env) {
  const q = async (sql) => (await env.DB.prepare(sql).all()).results || [];
  const [site, sitePeriodRows, sources, pages, searchEngines, devices, regions, goals, seo, seoSummaryRows, seoIndex, seoProblems, adsMeta, adsDaily, social, email, resolvedRows] = await Promise.all([
    q(`SELECT date,visits,users,pageviews,bounce_rate AS bounceRate,depth,duration,conversions,new_visitors AS newVisitors,email_clicks AS emailClicks,form_submits AS formSubmits FROM daily_site_metrics ORDER BY date`),
    q(`SELECT period_days AS periodDays,visits,users,pageviews,bounce_rate AS bounceRate,depth,duration,new_visitors AS newVisitors,conversions,email_clicks AS emailClicks,form_submits AS formSubmits FROM site_period_summary ORDER BY period_days`),
    q(`SELECT name,visits,users,bounce,conversions FROM traffic_sources WHERE period_key=(SELECT MAX(period_key) FROM traffic_sources) ORDER BY visits DESC`),
    q(`SELECT page,title,visits,users,bounce,depth,duration,conversions FROM landing_pages WHERE period_key=(SELECT MAX(period_key) FROM landing_pages) ORDER BY visits DESC LIMIT 150`),
    q(`SELECT name,visits,users FROM search_engines WHERE period_key=(SELECT MAX(period_key) FROM search_engines) ORDER BY visits DESC`),
    q(`SELECT name,visits,users FROM device_stats WHERE period_key=(SELECT MAX(period_key) FROM device_stats) ORDER BY visits DESC`),
    q(`SELECT name,visits,users FROM region_stats WHERE period_key=(SELECT MAX(period_key) FROM region_stats) ORDER BY visits DESC LIMIT 50`),
    q(`SELECT goal_id AS goalId,name,type,category,reaches,visits,conversion_rate AS conversionRate FROM metrika_goals WHERE period_key=(SELECT MAX(period_key) FROM metrika_goals) ORDER BY reaches DESC`),
    q(`SELECT query,shows,clicks,ctr,position,delta FROM seo_queries ORDER BY shows DESC LIMIT 1000`),
    q(`SELECT sqi,excluded_pages AS excludedPages,searchable_pages AS searchablePages,fatal,critical,possible,recommendation,updated_at AS updatedAt FROM seo_summary WHERE id=1`),
    q(`SELECT date,pages_in_search AS pagesInSearch FROM seo_index_history ORDER BY date`),
    q(`SELECT code,severity,state,last_update AS lastUpdate FROM seo_problems ORDER BY CASE severity WHEN 'FATAL' THEN 1 WHEN 'CRITICAL' THEN 2 WHEN 'POSSIBLE_PROBLEM' THEN 3 ELSE 4 END, code`),
    q(`SELECT channel,campaign_id AS campaignId,name,status,native_state AS nativeState,updated_at AS updatedAt FROM ad_campaign_meta ORDER BY channel,name`),
    q(`SELECT channel,campaign_id AS campaignId,name,date,impressions,clicks,spend,conversions FROM ad_campaign_daily ORDER BY date,channel,name`),
    q(`SELECT channel,title,date,reach,views,reactions,comments,shares,clicks,followers,followers_delta AS followersDelta FROM social_posts ORDER BY date DESC`),
    q(`SELECT id,name,date,status,sent,delivered,opened,clicked,unsub,spam,errors,report_url AS reportUrl FROM email_campaigns ORDER BY date DESC`),
    q(`SELECT source,external_id AS externalId,label FROM resolved_integrations`)
  ]);
  const goalMapping = {
    email: goals.filter(x => x.category === 'email').map(x => x.name),
    forms: goals.filter(x => x.category === 'form').map(x => x.name)
  };
  const sitePeriods = Object.fromEntries(sitePeriodRows.map(x => [String(x.periodDays), x]));
  const resolved = Object.fromEntries((resolvedRows || []).map(x => [x.source, x]));
  return json({
    site, sitePeriods, sources, pages, searchEngines, devices, regions, goals, seo,
    seoSummary: seoSummaryRows[0] || null, seoIndex, seoProblems,
    adsMeta, adsDaily, social, email,
    meta: { metrikaCounterId: env.METRIKA_COUNTER_ID || resolved.metrika?.externalId || null, webmasterHostId: env.WEBMASTER_HOST_ID || resolved.webmaster?.externalId || null, siteUrl: env.SITE_URL || null, goalMapping }
  });
}

async function syncConfigured(env) {
  await ensureExtendedSchema(env);
  const jobs = [];
  if (env.YANDEX_TOKEN && (env.METRIKA_COUNTER_ID || env.SITE_URL)) jobs.push(syncMetrika(env));
  if (env.YANDEX_TOKEN && (env.WEBMASTER_HOST_ID || env.SITE_URL)) jobs.push(syncWebmaster(env));
  if (env.DIRECT_TOKEN) jobs.push(syncDirect(env));
  if (env.VK_ADS_TOKEN || (env.VK_ADS_CLIENT_ID && env.VK_ADS_CLIENT_SECRET)) jobs.push(syncVkAds(env));
  if (env.UNISENDER_API_KEY) jobs.push(syncUnisender(env));
  if (env.MAX_BOT_TOKEN && env.MAX_CHANNEL_ID) jobs.push(syncMax(env));
  await Promise.allSettled(jobs);
}

async function syncSource(source, env) {
  await ensureExtendedSchema(env);
  if (source === 'metrika') return syncMetrika(env);
  if (source === 'webmaster') return syncWebmaster(env);
  if (source === 'direct') return syncDirect(env);
  if (source === 'vkads') return syncVkAds(env);
  if (source === 'unisender') return syncUnisender(env);
  if (source === 'maxsocial') return syncMax(env);
  throw new Error('Unknown source');
}

/* -------------------- YANDEX METRIKA -------------------- */

async function syncMetrika(env) {
  if (!env.YANDEX_TOKEN) throw new Error('Добавьте YANDEX_TOKEN в Cloudflare Runtime Secrets.');
  const headers = { Authorization: `OAuth ${env.YANDEX_TOKEN}` };
  const counterId = await resolveMetrikaCounterId(env, headers);
  await saveResolved(env, 'metrika', counterId, env.SITE_URL || `Счётчик ${counterId}`);
  const base = 'https://api-metrika.yandex.net/stat/v1/data';
  const common = { ids: counterId, date1: '89daysAgo', date2: 'today', accuracy: 'full' };

  const goalsInfo = await apiGet(`https://api-metrika.yandex.net/management/v1/counter/${encodeURIComponent(counterId)}/goals`, headers).catch(() => ({ goals: [] }));
  const goals = (goalsInfo.goals || []).filter(g => g?.status !== 'DELETED');
  const classified = goals.map(g => ({ ...g, category: classifyGoal(g) }));
  const selected = classified.filter(g => ['email', 'form'].includes(g.category)).slice(0, 20);

  const dailyMetrics = ['ym:s:visits','ym:s:users','ym:s:pageviews','ym:s:bounceRate','ym:s:pageDepth','ym:s:avgVisitDurationSeconds','ym:s:percentNewVisitors','ym:s:anyGoalReaches'];
  const dailyUrl = withParams(base, { ...common, dimensions: 'ym:s:date', metrics: dailyMetrics.join(',') });
  const sourceUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:trafficSourceName', metrics: 'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:anyGoalReaches', sort: '-ym:s:visits', limit: '100' });
  const pageUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:startURL', metrics: 'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds,ym:s:anyGoalReaches', sort: '-ym:s:visits', limit: '150' });
  const deviceUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:deviceCategory', metrics: 'ym:s:visits,ym:s:users', sort: '-ym:s:visits', limit: '30' });
  const regionUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:regionArea', metrics: 'ym:s:visits,ym:s:users', sort: '-ym:s:visits', limit: '50' });
  const engineUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:searchEngineName', metrics: 'ym:s:visits,ym:s:users', sort: '-ym:s:visits', limit: '50' });

  const results = await Promise.allSettled([
    apiGet(dailyUrl, headers), apiGet(sourceUrl, headers), apiGet(pageUrl, headers),
    apiGet(deviceUrl, headers), apiGet(regionUrl, headers), apiGet(engineUrl, headers)
  ]);
  const dailyRes = requiredResult(results[0], 'дневная статистика Метрики');
  const sourceRes = optionalResult(results[1]);
  const pageRes = optionalResult(results[2]);
  const deviceRes = optionalResult(results[3]);
  const regionRes = optionalResult(results[4]);
  const engineRes = optionalResult(results[5]);

  const dailyGoalMap = new Map();
  if (selected.length) {
    const goalMetrics = selected.map(g => `ym:s:goal${g.id}reaches`);
    const goalDaily = await apiGet(withParams(base, { ...common, dimensions: 'ym:s:date', metrics: goalMetrics.join(',') }), headers).catch(() => null);
    for (const row of goalDaily?.data || []) {
      const date = dimensionName(row.dimensions?.[0]);
      if (!date) continue;
      let emailClicks = 0, formSubmits = 0;
      selected.forEach((g, i) => {
        if (g.category === 'email') emailClicks += num(row.metrics?.[i]);
        if (g.category === 'form') formSubmits += num(row.metrics?.[i]);
      });
      dailyGoalMap.set(date, { emailClicks, formSubmits });
    }
  }

  for (const row of dailyRes.data || []) {
    const date = dimensionName(row.dimensions?.[0]);
    const m = row.metrics || [];
    if (!date) continue;
    const extra = dailyGoalMap.get(date) || { emailClicks: 0, formSubmits: 0 };
    await env.DB.prepare(`INSERT INTO daily_site_metrics(date,visits,users,pageviews,bounce_rate,depth,duration,conversions,new_visitors,email_clicks,form_submits,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(date) DO UPDATE SET visits=excluded.visits,users=excluded.users,pageviews=excluded.pageviews,bounce_rate=excluded.bounce_rate,depth=excluded.depth,duration=excluded.duration,conversions=excluded.conversions,new_visitors=excluded.new_visitors,email_clicks=excluded.email_clicks,form_submits=excluded.form_submits,updated_at=CURRENT_TIMESTAMP`)
      .bind(date,num(m[0]),num(m[1]),num(m[2]),num(m[3]),num(m[4]),num(m[5]),num(m[7]),num(m[6]),extra.emailClicks,extra.formSubmits).run();
  }

  const periodKey = dateOnly(new Date());
  await replaceDimensionTable(env, 'traffic_sources', periodKey, sourceRes.data || [], async (row) => {
    const m = row.metrics || []; return [dimensionName(row.dimensions?.[0]) || 'Прочее', num(m[0]), num(m[1]), num(m[2]), num(m[3])];
  });
  await env.DB.prepare('DELETE FROM landing_pages WHERE period_key=?').bind(periodKey).run();
  for (const row of pageRes.data || []) {
    const page = dimensionName(row.dimensions?.[0]); const m = row.metrics || []; if (!page) continue;
    await env.DB.prepare(`INSERT INTO landing_pages(period_key,page,title,visits,users,bounce,depth,duration,conversions,updated_at) VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .bind(periodKey,page,page,num(m[0]),num(m[1]),num(m[2]),num(m[3]),num(m[4]),num(m[5])).run();
  }
  await replaceSimpleDimension(env, 'device_stats', periodKey, deviceRes.data || []);
  await replaceSimpleDimension(env, 'region_stats', periodKey, regionRes.data || []);
  await replaceSimpleDimension(env, 'search_engines', periodKey, engineRes.data || []);

  await env.DB.prepare('DELETE FROM metrika_goals WHERE period_key=?').bind(periodKey).run();
  const cutoff30 = new Date(); cutoff30.setHours(0,0,0,0); cutoff30.setDate(cutoff30.getDate()-29);
  const totalVisits = num(sourceRes.totals?.[0]) || (dailyRes.data || []).filter(r => { const d=dimensionName(r.dimensions?.[0]); return d && new Date(`${d}T12:00:00`) >= cutoff30; }).reduce((a,r)=>a+num(r.metrics?.[0]),0);
  for (const chunk of chunks(classified, 20)) {
    if (!chunk.length) continue;
    const metrics = chunk.map(g => `ym:s:goal${g.id}reaches`).join(',');
    const report = await apiGet(withParams(base, { ids: counterId, date1: '29daysAgo', date2: 'today', accuracy: 'full', metrics }), headers).catch(() => ({ totals: [] }));
    for (let i = 0; i < chunk.length; i++) {
      const g = chunk[i]; const reaches = num(report.totals?.[i]); const conv = totalVisits ? reaches / totalVisits * 100 : 0;
      await env.DB.prepare(`INSERT INTO metrika_goals(period_key,goal_id,name,type,category,reaches,visits,conversion_rate) VALUES(?,?,?,?,?,?,?,?)`)
        .bind(periodKey,String(g.id),String(g.name || `Цель ${g.id}`),String(g.type || ''),g.category || 'other',reaches,totalVisits,conv).run();
    }
  }

  for (const periodDays of [7,30,90]) {
    const aggregate = await apiGet(withParams(base, { ids: counterId, date1: `${periodDays-1}daysAgo`, date2: 'today', accuracy: 'full', metrics: dailyMetrics.join(',') }), headers).catch(() => null);
    if (!aggregate) continue;
    const t = aggregate.totals || [];
    const cutoff = new Date(); cutoff.setHours(0,0,0,0); cutoff.setDate(cutoff.getDate()-(periodDays-1));
    let emailClicks=0, formSubmits=0;
    for (const [date, extra] of dailyGoalMap.entries()) { const d=new Date(`${date}T12:00:00`); if(d>=cutoff){emailClicks+=num(extra.emailClicks);formSubmits+=num(extra.formSubmits);} }
    await env.DB.prepare(`INSERT INTO site_period_summary(period_days,visits,users,pageviews,bounce_rate,depth,duration,new_visitors,conversions,email_clicks,form_submits,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(period_days) DO UPDATE SET visits=excluded.visits,users=excluded.users,pageviews=excluded.pageviews,bounce_rate=excluded.bounce_rate,depth=excluded.depth,duration=excluded.duration,new_visitors=excluded.new_visitors,conversions=excluded.conversions,email_clicks=excluded.email_clicks,form_submits=excluded.form_submits,updated_at=CURRENT_TIMESTAMP`)
      .bind(periodDays,num(t[0]),num(t[1]),num(t[2]),num(t[3]),num(t[4]),num(t[5]),num(t[6]),num(t[7]),emailClicks,formSubmits).run();
  }

  await logSync(env, 'metrika', 'ok', `Метрика: ${dailyRes.data?.length || 0} дней, ${goals.length} целей`);
  return { message: `Метрика обновлена: ${dailyRes.data?.length || 0} дней, ${goals.length} целей. Email и формы считаются только по найденным целям.` };
}

function classifyGoal(goal) {
  const type = String(goal?.type || '').toLowerCase();
  const name = String(goal?.name || '').toLowerCase();
  if (type === 'email' || /(e-?mail|почт|mailto)/i.test(name)) return 'email';
  if (/(отправ|заяв|форм|обратн.{0,8}связ|request|application|lead|заказ.{0,8}звон)/i.test(name)) return 'form';
  return 'other';
}

async function replaceDimensionTable(env, table, periodKey, rows, mapper) {
  await env.DB.prepare(`DELETE FROM ${table} WHERE period_key=?`).bind(periodKey).run();
  for (const row of rows) {
    const x = await mapper(row); if (!x?.[0]) continue;
    await env.DB.prepare(`INSERT INTO ${table}(period_key,name,visits,users,bounce,conversions) VALUES(?,?,?,?,?,?)`).bind(periodKey,...x).run();
  }
}
async function replaceSimpleDimension(env, table, periodKey, rows) {
  await env.DB.prepare(`DELETE FROM ${table} WHERE period_key=?`).bind(periodKey).run();
  for (const row of rows) {
    const name = dimensionName(row.dimensions?.[0]); if (!name) continue;
    await env.DB.prepare(`INSERT INTO ${table}(period_key,name,visits,users) VALUES(?,?,?,?)`).bind(periodKey,name,num(row.metrics?.[0]),num(row.metrics?.[1])).run();
  }
}

/* -------------------- YANDEX WEBMASTER -------------------- */

async function syncWebmaster(env) {
  if (!env.YANDEX_TOKEN) throw new Error('Добавьте YANDEX_TOKEN в Cloudflare Runtime Secrets.');
  const headers = { Authorization: `OAuth ${env.YANDEX_TOKEN}` };
  const user = await apiGet('https://api.webmaster.yandex.net/v4/user', headers);
  const uid = user.user_id || user.userId;
  if (!uid) throw new Error('Вебмастер не вернул user_id. Проверьте OAuth-доступ webmaster:hostinfo.');
  const hostId = await resolveWebmasterHostId(env, headers, uid);
  await saveResolved(env, 'webmaster', hostId, env.SITE_URL || hostId);
  const host = encodeURIComponent(hostId);
  const root = `https://api.webmaster.yandex.net/v4/user/${uid}/hosts/${host}`;
  const end = new Date(), start = new Date(); start.setDate(start.getDate() - 29);
  const prevStart = new Date(); prevStart.setDate(prevStart.getDate() - 59);
  const prevEnd = new Date(); prevEnd.setDate(prevEnd.getDate() - 30);
  const historyStart = new Date(); historyStart.setDate(historyStart.getDate() - 89);
  const params = { order_by: 'TOTAL_SHOWS', query_indicator: ['TOTAL_SHOWS','TOTAL_CLICKS','AVG_SHOW_POSITION'], date_from: dateOnly(start), date_to: dateOnly(end), limit: '500' };

  const [current, prev, summary, diagnostics, indexHistory] = await Promise.all([
    apiGet(withParams(`${root}/search-queries/popular`, params), headers),
    apiGet(withParams(`${root}/search-queries/popular`, { ...params, date_from: dateOnly(prevStart), date_to: dateOnly(prevEnd) }), headers).catch(() => ({ queries: [] })),
    apiGet(`${root}/summary`, headers).catch(() => null),
    apiGet(`${root}/diagnostics`, headers).catch(() => ({ problems: {} })),
    apiGet(withParams(`${root}/search-urls/in-search/history`, { date_from: dateOnly(historyStart), date_to: dateOnly(end) }), headers).catch(() => ({ history: [] }))
  ]);

  const prevByText = new Map((prev.queries || []).map(q => [q.query_text, q]));
  await env.DB.prepare('DELETE FROM seo_queries').run();
  for (const q of current.queries || []) {
    const ind = q.indicators || {};
    const shows = num(ind.TOTAL_SHOWS), clicks = num(ind.TOTAL_CLICKS), position = num(ind.AVG_SHOW_POSITION);
    const prevQ = prevByText.get(q.query_text), prevPos = num(prevQ?.indicators?.AVG_SHOW_POSITION);
    const delta = prevPos && position ? prevPos - position : 0;
    const ctr = shows ? clicks / shows * 100 : 0;
    await env.DB.prepare(`INSERT INTO seo_queries(query,shows,clicks,ctr,position,delta,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .bind(q.query_text,shows,clicks,ctr,position,delta).run();
  }

  if (summary) {
    const p = summary.site_problems || {};
    await env.DB.prepare(`INSERT INTO seo_summary(id,sqi,excluded_pages,searchable_pages,fatal,critical,possible,recommendation,updated_at) VALUES(1,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET sqi=excluded.sqi,excluded_pages=excluded.excluded_pages,searchable_pages=excluded.searchable_pages,fatal=excluded.fatal,critical=excluded.critical,possible=excluded.possible,recommendation=excluded.recommendation,updated_at=CURRENT_TIMESTAMP`)
      .bind(num(summary.sqi),num(summary.excluded_pages_count),num(summary.searchable_pages_count),num(p.FATAL),num(p.CRITICAL),num(p.POSSIBLE_PROBLEM),num(p.RECOMMENDATION)).run();
  }

  await env.DB.prepare('DELETE FROM seo_problems').run();
  for (const [code, p] of Object.entries(diagnostics.problems || {})) {
    await env.DB.prepare(`INSERT INTO seo_problems(code,severity,state,last_update) VALUES(?,?,?,?)`)
      .bind(code,String(p?.severity || ''),String(p?.state || ''),String(p?.last_state_update || '')).run();
  }

  await env.DB.prepare('DELETE FROM seo_index_history').run();
  for (const item of indexHistory.history || []) {
    const date = String(item.date || '').slice(0,10); if (!date) continue;
    await env.DB.prepare(`INSERT INTO seo_index_history(date,pages_in_search) VALUES(?,?) ON CONFLICT(date) DO UPDATE SET pages_in_search=excluded.pages_in_search`)
      .bind(date,num(item.value)).run();
  }

  await logSync(env, 'webmaster', 'ok', `Вебмастер: ${current.queries?.length || 0} запросов, ${Object.keys(diagnostics.problems || {}).length} диагностик`);
  return { message: `Вебмастер обновлён: ${current.queries?.length || 0} запросов, индексация и диагностика загружены.` };
}

/* -------------------- YANDEX DIRECT -------------------- */

async function syncDirect(env) {
  if (!env.DIRECT_TOKEN) throw new Error('Добавьте DIRECT_TOKEN. Для API Яндекс Директа также нужен одобренный доступ приложения.');
  const headers = { 'Authorization': `Bearer ${env.DIRECT_TOKEN}`, 'Accept-Language': 'ru', 'Content-Type': 'application/json' };
  if (env.DIRECT_CLIENT_LOGIN) headers['Client-Login'] = env.DIRECT_CLIENT_LOGIN;

  const campaignResponse = await fetch('https://api.direct.yandex.com/json/v501/campaigns', {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'get', params: { SelectionCriteria: {}, FieldNames: ['Id','Name','State','Status','StatusPayment','Type'] } })
  });
  if (!campaignResponse.ok) throw new Error(`Direct campaigns API ${campaignResponse.status}: ${(await campaignResponse.text()).slice(0,500)}`);
  const campaignJson = await campaignResponse.json();
  if (campaignJson.error) throw new Error(`Direct campaigns: ${campaignJson.error.error_detail || campaignJson.error.error_string || 'ошибка'}`);
  const campaigns = campaignJson.result?.Campaigns || [];

  await env.DB.prepare(`DELETE FROM ad_campaign_meta WHERE channel='Яндекс Директ'`).run();
  for (const c of campaigns) {
    await env.DB.prepare(`INSERT INTO ad_campaign_meta(channel,campaign_id,name,status,native_state,updated_at) VALUES('Яндекс Директ',?,?,?,?,CURRENT_TIMESTAMP)`)
      .bind(String(c.Id),String(c.Name || `Кампания ${c.Id}`),directStateRu(c.State),String(c.State || c.Status || '')).run();
  }

  const end = new Date(), start = new Date(); start.setDate(start.getDate() - 89);
  const reportBody = { params: {
    SelectionCriteria: { DateFrom: dateOnly(start), DateTo: dateOnly(end) },
    FieldNames: ['Date','CampaignId','CampaignName','Impressions','Clicks','Cost','Conversions'],
    ReportName: `CS Marketing ${Date.now()}`,
    ReportType: 'CAMPAIGN_PERFORMANCE_REPORT', DateRangeType: 'CUSTOM_DATE', Format: 'TSV', IncludeVAT: 'YES', IncludeDiscount: 'YES'
  }};
  const reportHeaders = { ...headers, 'returnMoneyInMicros': 'false' };
  const res = await fetch('https://api.direct.yandex.com/json/v501/reports', { method:'POST', headers: reportHeaders, body: JSON.stringify(reportBody) });
  if (res.status === 201 || res.status === 202) {
    await logSync(env,'direct','pending',`Статусы ${campaigns.length} кампаний обновлены, отчёт формируется`);
    return { message: `Статусы ${campaigns.length} кампаний обновлены. Статистика Директа ещё формируется — повторите синхронизацию позже.` };
  }
  if (!res.ok) throw new Error(`Direct Reports API ${res.status}: ${(await res.text()).slice(0,500)}`);
  const rows = parseDirectTsv(await res.text());
  await env.DB.prepare(`DELETE FROM ad_campaign_daily WHERE channel='Яндекс Директ'`).run();
  const metaById = new Map(campaigns.map(c => [String(c.Id), c]));
  for (const r of rows) {
    const id = String(r.CampaignId || ''); if (!id || !r.Date) continue;
    const c = metaById.get(id);
    const name = r.CampaignName || c?.Name || `Кампания ${id}`;
    await env.DB.prepare(`INSERT INTO ad_campaign_daily(channel,campaign_id,name,date,impressions,clicks,spend,conversions) VALUES('Яндекс Директ',?,?,?,?,?,?,?)
      ON CONFLICT(channel,campaign_id,date) DO UPDATE SET name=excluded.name,impressions=excluded.impressions,clicks=excluded.clicks,spend=excluded.spend,conversions=excluded.conversions`)
      .bind(id,name,r.Date,num(r.Impressions),num(r.Clicks),num(r.Cost),num(r.Conversions)).run();
  }
  await logSync(env,'direct','ok',`Директ: ${campaigns.length} кампаний, ${rows.length} строк статистики`);
  return { message: `Яндекс Директ обновлён: ${campaigns.length} кампаний, ${rows.length} дневных строк. Расходы берутся только из API.` };
}

function directStateRu(state) {
  const s = String(state || '').toUpperCase();
  if (s === 'ON') return 'active';
  if (s === 'SUSPENDED') return 'suspended';
  if (s === 'OFF') return 'inactive';
  if (['ENDED','ARCHIVED','CONVERTED'].includes(s)) return 'ended';
  return String(state || 'unknown');
}

/* -------------------- VK ADS -------------------- */

async function syncVkAds(env) {
  if (!env.VK_ADS_TOKEN && !(env.VK_ADS_CLIENT_ID && env.VK_ADS_CLIENT_SECRET)) {
    throw new Error('Добавьте VK_ADS_CLIENT_ID и VK_ADS_CLIENT_SECRET (или готовый VK_ADS_TOKEN) в Cloudflare Runtime Variables/Secrets.');
  }
  const token = await getVkAdsToken(env);
  const headers = { Authorization: `Bearer ${token}`, 'Accept-Language': 'ru' };
  const campaigns = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    const page = await apiGet(withParams('https://ads.vk.com/api/v2/ad_plans.json', { limit: 50, offset, fields: 'id,name,status' }), headers);
    const items = Array.isArray(page?.items) ? page.items : Array.isArray(page) ? page : [];
    campaigns.push(...items);
    if (items.length < 50 || (Number(page?.count) && campaigns.length >= Number(page.count))) break;
  }

  await env.DB.prepare(`DELETE FROM ad_campaign_meta WHERE channel='VK Реклама'`).run();
  for (const c of campaigns) {
    if (!c?.id) continue;
    await env.DB.prepare(`INSERT INTO ad_campaign_meta(channel,campaign_id,name,status,native_state,updated_at) VALUES('VK Реклама',?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(channel,campaign_id) DO UPDATE SET name=excluded.name,status=excluded.status,native_state=excluded.native_state,updated_at=CURRENT_TIMESTAMP`)
      .bind(String(c.id), String(c.name || `Кампания ${c.id}`), vkAdsState(c.status), String(c.status || '')).run();
  }

  const end = new Date(), start = new Date(); start.setDate(start.getDate() - 89);
  const ids = campaigns.map(c => c?.id).filter(Boolean).map(String);
  const allRows = [];
  for (const group of chunks(ids, 200)) {
    if (!group.length) continue;
    const url = withParams('https://ads.vk.com/api/v2/statistics/ad_plans/day.json', {
      id: group.join(','), date_from: dateOnly(start), date_to: dateOnly(end), metrics: 'base'
    });
    const payload = await apiGet(url, headers).catch(err => ({ __error: err.message }));
    if (payload?.__error) {
      await logSync(env, 'vkads', 'partial', `Кампании загружены, статистика VK Ads недоступна: ${payload.__error.slice(0,350)}`);
      return { message: `VK Реклама: загружено ${campaigns.length} кампаний. Статистика пока не загрузилась; статусы кампаний уже сохранены.` };
    }
    allRows.push(...extractVkStatsRows(payload));
  }

  await env.DB.prepare(`DELETE FROM ad_campaign_daily WHERE channel='VK Реклама'`).run();
  const names = new Map(campaigns.map(c => [String(c.id), String(c.name || `Кампания ${c.id}`)]));
  for (const r of allRows) {
    if (!r.id || !r.date) continue;
    await env.DB.prepare(`INSERT INTO ad_campaign_daily(channel,campaign_id,name,date,impressions,clicks,spend,conversions) VALUES('VK Реклама',?,?,?,?,?,?,?)
      ON CONFLICT(channel,campaign_id,date) DO UPDATE SET name=excluded.name,impressions=excluded.impressions,clicks=excluded.clicks,spend=excluded.spend,conversions=excluded.conversions`)
      .bind(String(r.id), names.get(String(r.id)) || `Кампания ${r.id}`, r.date, num(r.impressions), num(r.clicks), num(r.spend), num(r.conversions)).run();
  }
  await logSync(env, 'vkads', 'ok', `VK Реклама: ${campaigns.length} кампаний, ${allRows.length} дневных строк`);
  return { message: `VK Реклама обновлена: ${campaigns.length} кампаний, ${allRows.length} строк статистики.` };
}

async function getVkAdsToken(env) {
  if (env.VK_ADS_TOKEN) return String(env.VK_ADS_TOKEN);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: String(env.VK_ADS_CLIENT_ID),
    client_secret: String(env.VK_ADS_CLIENT_SECRET)
  });
  const res = await fetch('https://ads.vk.com/api/v2/oauth2/token.json', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
  });
  const text = await res.text();
  let data = {}; try { data = JSON.parse(text); } catch {}
  if (!res.ok || !data.access_token) throw new Error(`VK Ads OAuth ${res.status}: ${data?.error?.message || data?.error_description || text.slice(0,400)}`);
  return String(data.access_token);
}

function vkAdsState(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active') return 'active';
  if (s === 'blocked') return 'suspended';
  if (s === 'deleted') return 'ended';
  return s || 'unknown';
}

function extractVkStatsRows(payload) {
  const out = [];
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.data) ? payload.data : [];
  const pushRow = (parent, row) => {
    const id = row?.id ?? row?.object_id ?? row?.ad_plan_id ?? parent?.id ?? parent?.object_id ?? parent?.ad_plan_id;
    const date = String(row?.date ?? row?.day ?? row?.period ?? parent?.date ?? '').slice(0,10);
    const base = row?.base || row?.metrics?.base || row?.metrics || row || {};
    if (!id || !date) return;
    out.push({
      id: String(id), date,
      impressions: num(base.shows ?? base.impressions),
      clicks: num(base.clicks),
      spend: num(base.spent ?? base.spend ?? base.cost),
      conversions: num(base.conversions ?? base.goals ?? base.goal_reaches)
    });
  };
  for (const item of items) {
    const rows = item?.rows || item?.items || item?.data || item?.periods;
    if (Array.isArray(rows)) rows.forEach(r => pushRow(item, r)); else pushRow(item, item);
  }
  return out;
}

/* -------------------- UNISENDER -------------------- */

async function syncUnisender(env) {
  if (!env.UNISENDER_API_KEY) throw new Error('Добавьте UNISENDER_API_KEY в Cloudflare Runtime Secrets.');
  const end = new Date(), start = new Date(); start.setDate(start.getDate() - 89);
  const from = `${dateOnly(start)} 00:00:00`, to = `${dateOnly(end)} 23:59:59`;
  const listUrl = withParams('https://api.unisender.com/ru/api/getCampaigns', { format:'json', api_key:env.UNISENDER_API_KEY, from, to, limit:200, offset:0 });
  const list = await apiGet(listUrl, {});
  if (list.error) throw new Error(`UniSender: ${list.error}`);
  const campaigns = Array.isArray(list.result) ? list.result : [];

  await env.DB.prepare('DELETE FROM email_campaigns').run();
  let completed = 0;
  for (const group of chunks(campaigns.slice(0,200), 8)) {
    const stats = await Promise.all(group.map(async c => {
      const url = withParams('https://api.unisender.com/ru/api/getCampaignCommonStats', { format:'json', api_key:env.UNISENDER_API_KEY, campaign_id:c.id });
      const data = await apiGet(url, {}).catch(() => ({ result: {} }));
      return { c, s: data.result || {} };
    }));
    for (const { c, s } of stats) {
      const sent = num(s.sent), delivered = num(s.delivered), opened = num(s.read_unique), clicked = num(s.clicked_unique), unsub = num(s.unsubscribed), spam = num(s.spam);
      const errors = Math.max(0, sent - delivered);
      await env.DB.prepare(`INSERT INTO email_campaigns(id,name,date,status,sent,delivered,opened,clicked,unsub,spam,errors,report_url,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
        .bind(String(c.id),String(c.subject || `Рассылка ${c.id}`),String(c.start_time || '').slice(0,10),String(c.status || ''),sent,delivered,opened,clicked,unsub,spam,errors,String(c.stats_url || '')).run();
      completed++;
    }
  }
  await logSync(env,'unisender','ok',`UniSender: ${completed} рассылок`);
  return { message: `UniSender обновлён: ${completed} рассылок за последние 90 дней.` };
}

/* -------------------- MAX -------------------- */

async function syncMax(env) {
  if (!env.MAX_BOT_TOKEN || !env.MAX_CHANNEL_ID) throw new Error('Добавьте MAX_BOT_TOKEN как Secret и MAX_CHANNEL_ID как Variable. Бот должен быть администратором канала.');
  const headers = { Authorization: String(env.MAX_BOT_TOKEN) };
  const url = withParams('https://platform-api2.max.ru/messages', { chat_id: String(env.MAX_CHANNEL_ID), count: 100 });
  const payload = await apiGet(url, headers);
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const cutoff = Date.now() - 90 * 86400000;
  const recent = messages.filter(m => num(m?.timestamp) >= cutoff);
  await env.DB.prepare(`DELETE FROM social_posts WHERE channel='MAX'`).run();
  for (const m of recent) {
    const date = new Date(num(m.timestamp));
    if (Number.isNaN(date.getTime())) continue;
    const text = String(m?.body?.text || '').replace(/\s+/g,' ').trim();
    const title = text ? text.slice(0,140) : `Пост MAX ${String(m?.body?.mid || m?.id || m.timestamp)}`;
    const stat = m?.stat || {};
    await env.DB.prepare(`INSERT INTO social_posts(channel,title,date,reach,views,reactions,comments,shares,clicks,followers,followers_delta,updated_at) VALUES('MAX',?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(channel,title,date) DO UPDATE SET reach=excluded.reach,views=excluded.views,reactions=excluded.reactions,comments=excluded.comments,shares=excluded.shares,clicks=excluded.clicks,updated_at=CURRENT_TIMESTAMP`)
      .bind(title,dateOnly(date),num(stat.views),num(stat.views),num(stat.reactions),num(stat.comments),num(stat.reposts ?? stat.shares),0,0,0).run();
  }
  await logSync(env,'maxsocial','ok',`MAX: ${recent.length} последних постов из доступных 100`);
  return { message: `MAX обновлён: ${recent.length} постов за последние 90 дней (из последних 100 доступных API).` };
}

/* -------------------- IMPORTS -------------------- */

async function importRows(request, env) {
  const { source, rows, mode } = await request.json();
  if (!Array.isArray(rows)) return json({ error:'rows must be array' }, 400);
  const list = rows.slice(0,5000);

  if (source === 'site') {
    if (mode === 'replace') await env.DB.prepare('DELETE FROM daily_site_metrics').run();
    for (const x of list) {
      if (!x.date) continue;
      await env.DB.prepare(`INSERT INTO daily_site_metrics(date,visits,users,pageviews,bounce_rate,depth,duration,conversions,new_visitors,email_clicks,form_submits,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(date) DO UPDATE SET visits=excluded.visits,users=excluded.users,pageviews=excluded.pageviews,bounce_rate=excluded.bounce_rate,depth=excluded.depth,duration=excluded.duration,conversions=excluded.conversions,new_visitors=excluded.new_visitors,email_clicks=excluded.email_clicks,form_submits=excluded.form_submits,updated_at=CURRENT_TIMESTAMP`)
        .bind(x.date,num(x.visits),num(x.users),num(x.pageviews),num(x.bounceRate),num(x.depth),num(x.duration),num(x.conversions),num(x.newVisitors),num(x.emailClicks),num(x.formSubmits)).run();
    }
  }
  if (source === 'seo') {
    if (mode === 'replace') await env.DB.prepare('DELETE FROM seo_queries').run();
    for (const x of list) {
      if (!x.query) continue;
      await env.DB.prepare(`INSERT INTO seo_queries(query,shows,clicks,ctr,position,delta,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(query) DO UPDATE SET shows=excluded.shows,clicks=excluded.clicks,ctr=excluded.ctr,position=excluded.position,delta=excluded.delta,updated_at=CURRENT_TIMESTAMP`)
        .bind(x.query,num(x.shows),num(x.clicks),num(x.ctr),num(x.position),num(x.delta)).run();
    }
  }
  if (source === 'ads') {
    if (mode === 'replace') {
      await env.DB.prepare(`DELETE FROM ad_campaign_meta WHERE channel<>'Яндекс Директ'`).run();
      await env.DB.prepare(`DELETE FROM ad_campaign_daily WHERE channel<>'Яндекс Директ'`).run();
    }
    for (const x of list) {
      const channel = String(x.channel || 'Реклама'), name = String(x.name || 'Импортированная кампания');
      const id = String(x.campaignId || await shortHash(`${channel}|${name}`));
      const status = String(x.status || 'unknown'), date = String(x.date || dateOnly(new Date())).slice(0,10);
      await env.DB.prepare(`INSERT INTO ad_campaign_meta(channel,campaign_id,name,status,native_state,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(channel,campaign_id) DO UPDATE SET name=excluded.name,status=excluded.status,native_state=excluded.native_state,updated_at=CURRENT_TIMESTAMP`)
        .bind(channel,id,name,status,status).run();
      await env.DB.prepare(`INSERT INTO ad_campaign_daily(channel,campaign_id,name,date,impressions,clicks,spend,conversions) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(channel,campaign_id,date) DO UPDATE SET name=excluded.name,impressions=excluded.impressions,clicks=excluded.clicks,spend=excluded.spend,conversions=excluded.conversions`)
        .bind(channel,id,name,date,num(x.impressions),num(x.clicks),num(x.spend),num(x.conversions)).run();
    }
  }
  if (source === 'social') {
    if (mode === 'replace') await env.DB.prepare('DELETE FROM social_posts').run();
    for (const x of list) {
      const channel=String(x.channel||'Импорт'), title=String(x.title||'Публикация'), date=String(x.date||dateOnly(new Date())).slice(0,10);
      await env.DB.prepare(`INSERT INTO social_posts(channel,title,date,reach,views,reactions,comments,shares,clicks,followers,followers_delta,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(channel,title,date) DO UPDATE SET reach=excluded.reach,views=excluded.views,reactions=excluded.reactions,comments=excluded.comments,shares=excluded.shares,clicks=excluded.clicks,followers=excluded.followers,followers_delta=excluded.followers_delta,updated_at=CURRENT_TIMESTAMP`)
        .bind(channel,title,date,num(x.reach),num(x.views),num(x.reactions),num(x.comments),num(x.shares),num(x.clicks),num(x.followers),num(x.followersDelta)).run();
    }
  }
  if (source === 'email') {
    if (mode === 'replace') await env.DB.prepare('DELETE FROM email_campaigns').run();
    for (const x of list) {
      const id=String(x.id || await shortHash(`${x.name}|${x.date}`));
      await env.DB.prepare(`INSERT INTO email_campaigns(id,name,date,status,sent,delivered,opened,clicked,unsub,spam,errors,report_url,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,date=excluded.date,status=excluded.status,sent=excluded.sent,delivered=excluded.delivered,opened=excluded.opened,clicked=excluded.clicked,unsub=excluded.unsub,spam=excluded.spam,errors=excluded.errors,updated_at=CURRENT_TIMESTAMP`)
        .bind(id,String(x.name||'Рассылка'),String(x.date||'').slice(0,10),String(x.status||''),num(x.sent),num(x.delivered),num(x.opened),num(x.clicked),num(x.unsub),num(x.spam),num(x.errors),String(x.reportUrl||'')).run();
    }
  }
  return json({ ok:true, imported:list.length });
}

/* -------------------- INTEGRATION RESOLUTION -------------------- */

async function resolveMetrikaCounterId(env, headers) {
  if (env.METRIKA_COUNTER_ID) return String(env.METRIKA_COUNTER_ID);
  if (!env.SITE_URL) throw new Error('Для автоопределения счётчика добавьте SITE_URL или укажите METRIKA_COUNTER_ID вручную.');
  const data = await apiGet('https://api-metrika.yandex.net/management/v1/counters', headers);
  const counters = Array.isArray(data?.counters) ? data.counters : [];
  const wanted = normalizeHost(env.SITE_URL);
  const matches = counters.filter(c => normalizeHost(c?.site) === wanted || (c?.mirrors || []).some(m => normalizeHost(m) === wanted));
  if (matches.length === 1) return String(matches[0].id);
  if (!matches.length && counters.length === 1) return String(counters[0].id);
  const available = counters.slice(0,8).map(c => `${c.id}: ${c.site || c.name || 'без адреса'}`).join('; ');
  throw new Error(`Не удалось однозначно выбрать счётчик Метрики для ${env.SITE_URL}. Укажите METRIKA_COUNTER_ID вручную. Доступны: ${available || 'нет доступных счётчиков'}`);
}

async function resolveWebmasterHostId(env, headers, uid) {
  if (env.WEBMASTER_HOST_ID) return String(env.WEBMASTER_HOST_ID);
  if (!env.SITE_URL) throw new Error('Для автоопределения сайта Вебмастера добавьте SITE_URL или укажите WEBMASTER_HOST_ID вручную.');
  const data = await apiGet(`https://api.webmaster.yandex.net/v4/user/${encodeURIComponent(uid)}/hosts`, headers);
  const hosts = Array.isArray(data?.hosts) ? data.hosts : [];
  const wanted = normalizeHost(env.SITE_URL);
  const matches = hosts.filter(h => [h?.ascii_host_url, h?.unicode_host_url].some(x => normalizeHost(x) === wanted));
  if (matches.length === 1) return String(matches[0].host_id);
  if (!matches.length && hosts.length === 1) return String(hosts[0].host_id);
  const available = hosts.slice(0,8).map(h => `${h.host_id}: ${h.unicode_host_url || h.ascii_host_url || 'без адреса'}`).join('; ');
  throw new Error(`Не удалось однозначно выбрать сайт Вебмастера для ${env.SITE_URL}. Укажите WEBMASTER_HOST_ID вручную. Доступны: ${available || 'нет доступных сайтов'}`);
}

function normalizeHost(value) {
  if (!value) return '';
  try {
    const raw = String(value).trim();
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.hostname.toLowerCase().replace(/^www\./,'');
  } catch {
    return String(value).toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].split(':')[0];
  }
}

async function saveResolved(env, source, externalId, label) {
  await env.DB.prepare(`INSERT INTO resolved_integrations(source,external_id,label,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(source) DO UPDATE SET external_id=excluded.external_id,label=excluded.label,updated_at=CURRENT_TIMESTAMP`)
    .bind(source, String(externalId || ''), String(label || '')).run();
}

/* -------------------- HELPERS -------------------- */

function withParams(url, params) {
  const u = new URL(url);
  for (const [k,v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach(x => u.searchParams.append(k, x)); else u.searchParams.set(k, v);
  }
  return u.toString();
}
async function apiGet(url, headers = {}) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0,700)}`);
  try { return JSON.parse(text); } catch { throw new Error(`API вернул не JSON: ${text.slice(0,300)}`); }
}
function requiredResult(result, name) { if (result.status === 'rejected') throw new Error(`${name}: ${result.reason?.message || result.reason}`); return result.value; }
function optionalResult(result) { return result.status === 'fulfilled' ? result.value : { data: [], totals: [] }; }
function num(v) { const x = Number(String(v ?? 0).replace(',','.')); return Number.isFinite(x) ? x : 0; }
function dateOnly(d) { return d.toISOString().slice(0,10); }
function dimensionName(d) { return d?.name ?? d?.id ?? ''; }
function chunks(arr, size) { const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
function parseDirectTsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headerIndex = lines.findIndex(x => x.startsWith('Date\t'));
  if (headerIndex < 0) return [];
  const headers = lines[headerIndex].split('\t');
  return lines.slice(headerIndex+1).filter(x => !x.startsWith('Total rows:')).map(line => {
    const vals = line.split('\t'); return Object.fromEntries(headers.map((h,i) => [h, vals[i]]));
  });
}
async function logSync(env, source, statusValue, message) {
  await env.DB.prepare(`INSERT INTO sync_log(source,last_sync,status,message) VALUES(?,datetime('now'),?,?) ON CONFLICT(source) DO UPDATE SET last_sync=datetime('now'),status=excluded.status,message=excluded.message`)
    .bind(source,statusValue,message).run();
}
async function shortHash(value) { return (await sha256Hex(value)).slice(0,20); }
