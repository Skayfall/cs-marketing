// CS Marketing by skayfall v2.4 — server-first marketing OS: analytics + ads + social + Yandex Business + workspace
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const SESSION_COOKIE = 'cs_marketing_session';
const SESSION_TTL_SECONDS = 60 * 60 * 4;
const AUTH_HEADER_PREFIX = 'Bearer ';
const DEFAULT_SOCIAL_URLS = {
  vk: 'https://vk.ru/centr_santechniki',
  telegram: 'https://t.me/CS_trade_official',
  max: 'https://max.ru/id7724208038_biz',
  dzen: 'https://dzen.ru/centr_santehniki'
};

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
  if (request.method === 'GET' && url.pathname === '/api/range') return rangeAnalytics(url, env);
  if (request.method === 'GET' && url.pathname === '/api/workspace') return workspaceData(env);
  if (request.method === 'GET' && url.pathname === '/api/settings') return appSettingsGet(env);
  if (request.method === 'GET' && url.pathname === '/api/ybusiness/candidates') return ybusinessCandidatesResponse(env);
  if (request.method === 'POST' && url.pathname === '/api/settings') return appSettingsSave(request, env);
  if (request.method === 'POST' && url.pathname === '/api/workspace/upsert') return workspaceUpsert(request, env);
  if (request.method === 'DELETE' && url.pathname.startsWith('/api/workspace/item/')) return workspaceDelete(url, env);
  if (request.method === 'POST' && url.pathname === '/api/sync/all') return json(await syncConfigured(env), 200);
  if (request.method === 'POST' && url.pathname === '/api/import') return importRows(request, env);
  const m = url.pathname.match(/^\/api\/sync\/(metrika|webmaster|ybusiness|direct|vkads|vksocial|telegram|maxsocial|dzen|unisender)$/);
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
      `CREATE TABLE IF NOT EXISTS social_channel_daily (channel TEXT NOT NULL, date TEXT NOT NULL, views REAL DEFAULT 0, visitors REAL DEFAULT 0, reach REAL DEFAULT 0, subscribers_reach REAL DEFAULT 0, subscribed REAL DEFAULT 0, unsubscribed REAL DEFAULT 0, likes REAL DEFAULT 0, comments REAL DEFAULT 0, shares REAL DEFAULT 0, PRIMARY KEY(channel,date))`,
      `CREATE TABLE IF NOT EXISTS email_campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL, date TEXT, status TEXT, sent REAL DEFAULT 0, delivered REAL DEFAULT 0, opened REAL DEFAULT 0, opened_all REAL DEFAULT 0, clicked REAL DEFAULT 0, clicked_all REAL DEFAULT 0, unsub REAL DEFAULT 0, spam REAL DEFAULT 0, errors REAL DEFAULT 0, report_url TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS email_links (campaign_id TEXT NOT NULL, url TEXT NOT NULL, clicks REAL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(campaign_id,url))`,
      `CREATE TABLE IF NOT EXISTS utm_stats (period_key TEXT NOT NULL, source TEXT NOT NULL, medium TEXT NOT NULL, campaign TEXT NOT NULL, visits REAL DEFAULT 0, users REAL DEFAULT 0, bounce REAL DEFAULT 0, depth REAL DEFAULT 0, duration REAL DEFAULT 0, conversions REAL DEFAULT 0, PRIMARY KEY(period_key,source,medium,campaign))`,
      `CREATE TABLE IF NOT EXISTS search_phrases (period_key TEXT NOT NULL, engine TEXT NOT NULL, phrase TEXT NOT NULL, visits REAL DEFAULT 0, users REAL DEFAULT 0, bounce REAL DEFAULT 0, depth REAL DEFAULT 0, duration REAL DEFAULT 0, PRIMARY KEY(period_key,engine,phrase))`,
      `CREATE TABLE IF NOT EXISTS yandex_business_daily (date TEXT PRIMARY KEY, profile_views REAL DEFAULT 0, target_clients REAL DEFAULT 0, target_actions REAL DEFAULT 0, routes REAL DEFAULT 0, calls REAL DEFAULT 0, website_clicks REAL DEFAULT 0, direct_visits REAL DEFAULT 0, discovery_visits REAL DEFAULT 0, photo_views REAL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS yandex_business_queries (query TEXT NOT NULL, service TEXT NOT NULL DEFAULT '', visits REAL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(query,service))`,
      `CREATE TABLE IF NOT EXISTS workspace_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT, status TEXT, title TEXT NOT NULL, body TEXT, priority TEXT DEFAULT 'medium', due_date TEXT, checked INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS integration_cache (cache_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, expires_at INTEGER DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`
    ];
    for (const sql of creates) await env.DB.prepare(sql).run();
    const alters = [
      `ALTER TABLE daily_site_metrics ADD COLUMN new_visitors REAL DEFAULT 0`,
      `ALTER TABLE daily_site_metrics ADD COLUMN email_clicks REAL DEFAULT 0`,
      `ALTER TABLE daily_site_metrics ADD COLUMN form_submits REAL DEFAULT 0`,
      `ALTER TABLE traffic_sources ADD COLUMN users INTEGER DEFAULT 0`,
      `ALTER TABLE traffic_sources ADD COLUMN bounce REAL DEFAULT 0`,
      `ALTER TABLE landing_pages ADD COLUMN users INTEGER DEFAULT 0`,
      `ALTER TABLE landing_pages ADD COLUMN duration REAL DEFAULT 0`,
      `ALTER TABLE seo_queries ADD COLUMN click_position REAL DEFAULT 0`,
      `ALTER TABLE ad_campaign_daily ADD COLUMN bounce_rate REAL DEFAULT 0`,
      `ALTER TABLE ad_campaign_daily ADD COLUMN avg_pageviews REAL DEFAULT 0`,
      `ALTER TABLE email_campaigns ADD COLUMN opened_all REAL DEFAULT 0`,
      `ALTER TABLE email_campaigns ADD COLUMN clicked_all REAL DEFAULT 0`,
      `ALTER TABLE social_posts ADD COLUMN post_id TEXT`,
      `ALTER TABLE social_posts ADD COLUMN post_url TEXT`,
      `ALTER TABLE social_posts ADD COLUMN media_type TEXT`,
      `ALTER TABLE social_posts ADD COLUMN text_length REAL DEFAULT 0`
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
  const item = (source, configured, missing, mode = 'api', extra = {}) => ({
    connected: Boolean(configured),
    configured: Boolean(configured),
    missing,
    mode,
    lastSync: map[source]?.last_sync || null,
    status: map[source]?.status || null,
    message: map[source]?.message || null,
    resolvedId: resolved[source]?.external_id || null,
    resolvedLabel: resolved[source]?.label || null,
    ...extra
  });

  const yandexBase = Boolean(env.YANDEX_TOKEN);
  const metrikaTarget = Boolean(env.METRIKA_COUNTER_ID || env.SITE_URL);
  const webmasterTarget = Boolean(env.WEBMASTER_HOST_ID || env.SITE_URL);
  const vkAdsReady = Boolean(env.VK_ADS_TOKEN || (env.VK_ADS_CLIENT_ID && env.VK_ADS_CLIENT_SECRET));
  const vkAdsPartial = Boolean(env.VK_ADS_CLIENT_SECRET && !env.VK_ADS_CLIENT_ID && !env.VK_ADS_TOKEN);
  const vkSocialReady = true; // публичный URL задан по умолчанию; API-токены лишь расширяют статистику
  const telegramReady = true;
  const maxReady = true;
  const dzenReady = true;

  const integrations = {
    metrika: item('metrika', yandexBase && metrikaTarget,
      [!env.YANDEX_TOKEN && 'YANDEX_TOKEN', !metrikaTarget && 'SITE_URL или METRIKA_COUNTER_ID'].filter(Boolean)),
    webmaster: item('webmaster', yandexBase && webmasterTarget,
      [!env.YANDEX_TOKEN && 'YANDEX_TOKEN', !webmasterTarget && 'SITE_URL или WEBMASTER_HOST_ID'].filter(Boolean)),
    direct: item('direct', yandexBase,
      [!env.YANDEX_TOKEN && 'YANDEX_TOKEN'].filter(Boolean), 'api',
      { note: yandexBase ? 'Используется тот же YANDEX_TOKEN. Если Direct API ещё не одобрен, приложение автоматически берёт кампании, клики и расходы из отчёта «Директ, расходы» Яндекс Метрики.' : null }),
    vkads: item('vkads', vkAdsReady,
      [
        !env.VK_ADS_TOKEN && !env.VK_ADS_CLIENT_ID && 'VK_ADS_CLIENT_ID',
        !env.VK_ADS_TOKEN && !env.VK_ADS_CLIENT_SECRET && 'VK_ADS_CLIENT_SECRET'
      ].filter(Boolean), 'api',
      { partial: vkAdsPartial, note: vkAdsPartial ? 'VK_ADS_CLIENT_SECRET уже есть; нужен только VK_ADS_CLIENT_ID как обычная Variable.' : null }),
    vksocial: item('vksocial', vkSocialReady, [], env.VK_COMMUNITY_TOKEN ? 'hybrid' : 'public-web',
      { note: `Посты проверяются по публичной странице ${env.VK_COMMUNITY_URL || DEFAULT_SOCIAL_URLS.vk}. Если токен сообщества доступен, приложение дополнительно пробует получить агрегированную статистику.` }),
    telegram: item('telegram', telegramReady, [], 'public-web',
      { note: `Посты и просмотры проверяются по публичной web-ленте ${env.TELEGRAM_CHANNEL_URL || DEFAULT_SOCIAL_URLS.telegram}.` }),
    maxsocial: item('maxsocial', maxReady, [], env.MAX_BOT_TOKEN && env.MAX_CHANNEL_ID ? 'hybrid' : 'public-web',
      { note: `Посты проверяются по публичной странице ${env.MAX_CHANNEL_URL || DEFAULT_SOCIAL_URLS.max}. Bot API используется как расширенный источник, если настроен.` }),
    dzen: item('dzen', dzenReady, [], 'public-web',
      { note: `Публикации проверяются по публичной странице ${env.DZEN_CHANNEL_URL || DEFAULT_SOCIAL_URLS.dzen}. Сохраняются только метрики, которые Дзен реально отдаёт в публичной странице.` }),
    ybusiness: item('ybusiness', yandexBase, [!env.YANDEX_TOKEN && 'YANDEX_TOKEN'].filter(Boolean), 'metrika-business',
      { note: yandexBase ? 'Автоматически ищется специальный счётчик Яндекс Бизнеса в Метрике и его системные цели: звонки, маршруты, призывы к действию и просмотры контента.' : null }),
    unisender: item('unisender', Boolean(env.UNISENDER_API_KEY),
      [!env.UNISENDER_API_KEY && 'UNISENDER_API_KEY'].filter(Boolean))
  };

  const runtime = {
    ADMIN_PASSWORD: Boolean(env.ADMIN_PASSWORD),
    ADMIN_USERNAME: Boolean(env.ADMIN_USERNAME),
    SESSION_SECRET: Boolean(env.SESSION_SECRET),
    SITE_URL: Boolean(env.SITE_URL),
    YANDEX_TOKEN: Boolean(env.YANDEX_TOKEN),
    UNISENDER_API_KEY: Boolean(env.UNISENDER_API_KEY),
    VK_ADS_CLIENT_ID: Boolean(env.VK_ADS_CLIENT_ID),
    VK_ADS_CLIENT_SECRET: Boolean(env.VK_ADS_CLIENT_SECRET),
    VK_ADS_TOKEN: Boolean(env.VK_ADS_TOKEN),
    VK_COMMUNITY_TOKEN: Boolean(env.VK_COMMUNITY_TOKEN),
    VK_SERVICE_TOKEN: Boolean(env.VK_SERVICE_TOKEN),
    VK_USER_TOKEN: Boolean(env.VK_USER_TOKEN),
    VK_COMMUNITY_URL: Boolean(env.VK_COMMUNITY_URL),
    VK_GROUP_ID: Boolean(env.VK_GROUP_ID),
    TELEGRAM_CHANNEL_URL: Boolean(env.TELEGRAM_CHANNEL_URL),
    TELEGRAM_CHANNEL_USERNAME: Boolean(env.TELEGRAM_CHANNEL_USERNAME),
    MAX_BOT_TOKEN: Boolean(env.MAX_BOT_TOKEN),
    MAX_CHANNEL_ID: Boolean(env.MAX_CHANNEL_ID),
    METRIKA_COUNTER_ID: Boolean(env.METRIKA_COUNTER_ID),
    WEBMASTER_HOST_ID: Boolean(env.WEBMASTER_HOST_ID),
    MAX_CHANNEL_URL: Boolean(env.MAX_CHANNEL_URL),
    DZEN_CHANNEL_URL: Boolean(env.DZEN_CHANNEL_URL)
  };

  return json({
    mode: Object.values(integrations).some(x => x.connected) ? 'live' : 'empty',
    integrations,
    runtime,
    siteUrl: env.SITE_URL || null,
    metrikaCounterId: env.METRIKA_COUNTER_ID || resolved.metrika?.external_id || null,
    webmasterHostId: env.WEBMASTER_HOST_ID || resolved.webmaster?.external_id || null,
    vkGroupId: env.VK_GROUP_ID || resolved.vksocial?.external_id || null
  });
}

async function dashboard(env) {
  const q = async (sql) => (await env.DB.prepare(sql).all()).results || [];
  const [site, sitePeriodRows, sources, pages, searchEngines, searchPhrases, utm, devices, regions, goals, seo, seoSummaryRows, seoIndex, seoProblems, adsMeta, adsDaily, social, socialDaily, email, emailLinks, businessDaily, businessQueries, workspace, syncLog, resolvedRows, settingsRows] = await Promise.all([
    q(`SELECT date,visits,users,pageviews,bounce_rate AS bounceRate,depth,duration,conversions,new_visitors AS newVisitors,email_clicks AS emailClicks,form_submits AS formSubmits FROM daily_site_metrics ORDER BY date`),
    q(`SELECT period_days AS periodDays,visits,users,pageviews,bounce_rate AS bounceRate,depth,duration,new_visitors AS newVisitors,conversions,email_clicks AS emailClicks,form_submits AS formSubmits FROM site_period_summary ORDER BY period_days`),
    q(`SELECT name,visits,users,bounce,conversions FROM traffic_sources WHERE period_key=(SELECT MAX(period_key) FROM traffic_sources) ORDER BY visits DESC`),
    q(`SELECT page,title,visits,users,bounce,depth,duration,conversions FROM landing_pages WHERE period_key=(SELECT MAX(period_key) FROM landing_pages) ORDER BY visits DESC LIMIT 1000`),
    q(`SELECT name,visits,users FROM search_engines WHERE period_key=(SELECT MAX(period_key) FROM search_engines) ORDER BY visits DESC`),
    q(`SELECT engine,phrase,visits,users,bounce,depth,duration FROM search_phrases WHERE period_key=(SELECT MAX(period_key) FROM search_phrases) ORDER BY visits DESC LIMIT 200`),
    q(`SELECT source,medium,campaign,visits,users,bounce,depth,duration,conversions FROM utm_stats WHERE period_key=(SELECT MAX(period_key) FROM utm_stats) ORDER BY visits DESC LIMIT 300`),
    q(`SELECT name,visits,users FROM device_stats WHERE period_key=(SELECT MAX(period_key) FROM device_stats) ORDER BY visits DESC`),
    q(`SELECT name,visits,users FROM region_stats WHERE period_key=(SELECT MAX(period_key) FROM region_stats) ORDER BY visits DESC LIMIT 50`),
    q(`SELECT goal_id AS goalId,name,type,category,reaches,visits,conversion_rate AS conversionRate FROM metrika_goals WHERE period_key=(SELECT MAX(period_key) FROM metrika_goals) ORDER BY reaches DESC`),
    q(`SELECT query,shows,clicks,ctr,position,click_position AS clickPosition,delta FROM seo_queries ORDER BY shows DESC LIMIT 1000`),
    q(`SELECT sqi,excluded_pages AS excludedPages,searchable_pages AS searchablePages,fatal,critical,possible,recommendation,updated_at AS updatedAt FROM seo_summary WHERE id=1`),
    q(`SELECT date,pages_in_search AS pagesInSearch FROM seo_index_history ORDER BY date`),
    q(`SELECT code,severity,state,last_update AS lastUpdate FROM seo_problems ORDER BY CASE severity WHEN 'FATAL' THEN 1 WHEN 'CRITICAL' THEN 2 WHEN 'POSSIBLE_PROBLEM' THEN 3 ELSE 4 END, code`),
    q(`SELECT channel,campaign_id AS campaignId,name,status,native_state AS nativeState,updated_at AS updatedAt FROM ad_campaign_meta ORDER BY channel,name`),
    q(`SELECT channel,campaign_id AS campaignId,name,date,impressions,clicks,spend,conversions,bounce_rate AS bounceRate,avg_pageviews AS avgPageviews FROM ad_campaign_daily ORDER BY date,channel,name`),
    q(`SELECT channel,title,date,reach,views,reactions,comments,shares,clicks,followers,followers_delta AS followersDelta,post_id AS postId,post_url AS postUrl,media_type AS mediaType,text_length AS textLength FROM social_posts ORDER BY date DESC`),
    q(`SELECT channel,date,views,visitors,reach,subscribers_reach AS subscribersReach,subscribed,unsubscribed,likes,comments,shares FROM social_channel_daily ORDER BY date`),
    q(`SELECT id,name,date,status,sent,delivered,opened,opened_all AS openedAll,clicked,clicked_all AS clickedAll,unsub,spam,errors,report_url AS reportUrl FROM email_campaigns ORDER BY date DESC`),
    q(`SELECT campaign_id AS campaignId,url,clicks FROM email_links ORDER BY clicks DESC LIMIT 500`),
    q(`SELECT date,profile_views AS profileViews,target_clients AS targetClients,target_actions AS targetActions,routes,calls,website_clicks AS websiteClicks,direct_visits AS directVisits,discovery_visits AS discoveryVisits,photo_views AS photoViews FROM yandex_business_daily ORDER BY date`),
    q(`SELECT query,service,visits FROM yandex_business_queries ORDER BY visits DESC LIMIT 200`),
    q(`SELECT id,kind,parent_id AS parentId,status,title,body,priority,due_date AS dueDate,checked,pinned,sort_order AS sortOrder,created_at AS createdAt,updated_at AS updatedAt FROM workspace_items ORDER BY pinned DESC, sort_order, updated_at DESC`),
    q(`SELECT source,last_sync AS lastSync,status,message FROM sync_log ORDER BY source`),
    q(`SELECT source,external_id AS externalId,label FROM resolved_integrations`),
    q(`SELECT setting_key AS settingKey,setting_value AS settingValue FROM app_settings`)
  ]);
  const settings = Object.fromEntries((settingsRows || []).map(x => [x.settingKey, x.settingValue]));
  const goalMapping = {
    email: goals.filter(x => x.category === 'email').map(x => ({id:String(x.goalId),name:x.name,selected:String(x.goalId)===String(settings.primary_email_goal_id||'')})),
    forms: goals.filter(x => x.category === 'form').map(x => ({id:String(x.goalId),name:x.name,selected:String(x.goalId)===String(settings.primary_form_goal_id||'')})),
    primaryEmailGoalId: settings.primary_email_goal_id || null,
    primaryFormGoalId: settings.primary_form_goal_id || null
  };
  const sitePeriods = Object.fromEntries(sitePeriodRows.map(x => [String(x.periodDays), x]));
  const resolved = Object.fromEntries((resolvedRows || []).map(x => [x.source, x]));
  return json({
    site, sitePeriods, sources, pages, searchEngines, searchPhrases, utm, devices, regions, goals, seo,
    seoSummary: seoSummaryRows[0] || null, seoIndex, seoProblems,
    adsMeta, adsDaily, social, socialDaily, email, emailLinks, businessDaily, businessQueries, workspace, syncLog,
    meta: { metrikaCounterId: env.METRIKA_COUNTER_ID || resolved.metrika?.externalId || null, webmasterHostId: env.WEBMASTER_HOST_ID || resolved.webmaster?.externalId || null, vkGroupId: env.VK_GROUP_ID || resolved.vksocial?.externalId || null, siteUrl: env.SITE_URL || null, goalMapping, ybusinessCounterId: settings.ybusiness_profile_url ? (settings.ybusiness_counter_id || resolved.ybusiness?.externalId || null) : null, ybusinessProfileUrl: settings.ybusiness_profile_url || 'https://yandex.ru/sprav/173574593150/' }
  });
}


async function rangeAnalytics(url, env) {
  const { from, to, days } = validateRange(url.searchParams.get('from'), url.searchParams.get('to'));
  const result = { from, to, days, metrika: null, webmaster: null, warnings: [] };

  if (env.YANDEX_TOKEN && (env.METRIKA_COUNTER_ID || env.SITE_URL)) {
    try {
      result.metrika = await metrikaRangeData(env, from, to);
      if (Array.isArray(result.metrika?.warnings)) result.warnings.push(...result.metrika.warnings.map(x => `Метрика: ${x}`));
    } catch (err) { result.warnings.push(`Метрика: ${err?.message || err}`); }
  } else result.warnings.push('Метрика: нет YANDEX_TOKEN или SITE_URL/METRIKA_COUNTER_ID');

  if (env.YANDEX_TOKEN && (env.WEBMASTER_HOST_ID || env.SITE_URL)) {
    try { result.webmaster = await webmasterRangeData(env, from, to); }
    catch (err) { result.warnings.push(`Вебмастер: ${err?.message || err}`); }
  }
  return json(result, 200);
}

function validateRange(fromRaw, toRaw) {
  const today = dateOnly(new Date());
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(toRaw || '')) ? String(toRaw) : today;
  const fallback = new Date(`${to}T12:00:00Z`); fallback.setUTCDate(fallback.getUTCDate() - 29);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(fromRaw || '')) ? String(fromRaw) : dateOnly(fallback);
  const a = new Date(`${from}T12:00:00Z`), b = new Date(`${to}T12:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a > b) throw new Error('Некорректный период');
  const days = Math.floor((b - a) / 86400000) + 1;
  if (days < 1 || days > 366) throw new Error('Период должен быть от 1 до 366 дней');
  return { from, to, days };
}

async function metrikaRangeData(env, from, to) {
  const headers = { Authorization: `OAuth ${env.YANDEX_TOKEN}` };
  const counterId = await resolveMetrikaCounterId(env, headers);
  const base = 'https://api-metrika.yandex.net/stat/v1/data';
  const common = { ids: counterId, date1: from, date2: to, accuracy: 'full', lang: 'ru' };
  const defs = [
    ['sources', { dimensions:'ym:s:trafficSourceName', metrics:'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:anyGoalReaches', sort:'-ym:s:visits', limit:'100' }],
    ['pages', { dimensions:'ym:s:startURL', metrics:'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds,ym:s:anyGoalReaches', sort:'-ym:s:visits', limit:'1000' }],
    ['devices', { dimensions:'ym:s:deviceCategory', metrics:'ym:s:visits,ym:s:users', sort:'-ym:s:visits', limit:'30' }],
    ['regions', { dimensions:'ym:s:regionArea', metrics:'ym:s:visits,ym:s:users', sort:'-ym:s:visits', limit:'50' }],
    ['searchEngines', { dimensions:'ym:s:searchEngineName', metrics:'ym:s:visits,ym:s:users', sort:'-ym:s:visits', limit:'50' }],
    ['utm', { dimensions:'ym:s:lastSignUTMSource,ym:s:lastSignUTMMedium,ym:s:lastSignUTMCampaign', metrics:'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds,ym:s:anyGoalReaches', sort:'-ym:s:visits', limit:'300' }],
    ['searchPhrases', { dimensions:'ym:s:lastSignSearchEngineRootName,ym:s:lastSignSearchPhrase', metrics:'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds', sort:'-ym:s:visits', limit:'250' }]
  ];
  const settled = await Promise.allSettled(defs.map(([,params]) => apiGet(withParams(base, { ...common, ...params }), headers)));
  const labels = { sources:'источники', pages:'страницы входа', devices:'устройства', regions:'регионы', searchEngines:'поисковики', utm:'UTM', searchPhrases:'поисковые фразы' };
  const warnings = [];
  const raw = Object.fromEntries(defs.map(([name],i) => {
    if (settled[i].status === 'fulfilled') return [name, settled[i].value];
    const reason = settled[i].reason?.message || String(settled[i].reason || 'ошибка запроса');
    warnings.push(`${labels[name] || name}: ${reason}`);
    return [name, { data: [] }];
  }));

  const sources = (raw.sources.data || []).map(r => { const m=r.metrics||[]; return { name:dimensionName(r.dimensions?.[0])||'Прочее', visits:num(m[0]), users:num(m[1]), bounce:num(m[2]), conversions:num(m[3]) }; });
  const pages = (raw.pages.data || []).map(r => { const m=r.metrics||[], page=dimensionName(r.dimensions?.[0])||''; return { page, title:page, visits:num(m[0]), users:num(m[1]), bounce:num(m[2]), depth:num(m[3]), duration:num(m[4]), conversions:num(m[5]) }; }).filter(x=>x.page);
  const simple = key => (raw[key].data || []).map(r => ({ name:dimensionName(r.dimensions?.[0])||'Прочее', visits:num(r.metrics?.[0]), users:num(r.metrics?.[1]) }));
  const utm = (raw.utm.data || []).map(r => { const m=r.metrics||[]; return { source:dimensionName(r.dimensions?.[0])||'(не задано)', medium:dimensionName(r.dimensions?.[1])||'(не задано)', campaign:dimensionName(r.dimensions?.[2])||'(не задано)', visits:num(m[0]), users:num(m[1]), bounce:num(m[2]), depth:num(m[3]), duration:num(m[4]), conversions:num(m[5]) }; }).filter(x=>!(x.source==='(не задано)'&&x.medium==='(не задано)'&&x.campaign==='(не задано)'));
  const searchPhrases = (raw.searchPhrases.data || []).map(r => { const m=r.metrics||[]; return { engine:dimensionName(r.dimensions?.[0])||'Поиск', phrase:dimensionName(r.dimensions?.[1])||'', visits:num(m[0]), users:num(m[1]), bounce:num(m[2]), depth:num(m[3]), duration:num(m[4]) }; }).filter(x=>x.phrase);

  const goalsInfo = await apiGet(`https://api-metrika.yandex.net/management/v1/counter/${encodeURIComponent(counterId)}/goals`, headers).catch(() => ({ goals: [] }));
  const goalsDef = (goalsInfo.goals || []).filter(g=>g?.status!=='DELETED').map(g=>({...g,category:classifyGoal(g)}));
  const totalVisits = sources.reduce((a,x)=>a+num(x.visits),0) || num((await apiGet(withParams(base,{...common,metrics:'ym:s:visits'}),headers).catch(()=>({totals:[0]}))).totals?.[0]);
  const goals=[];
  for (const group of chunks(goalsDef,20)) {
    if(!group.length) continue;
    const metrics=group.map(g=>`ym:s:goal${g.id}reaches`).join(',');
    const report=await apiGet(withParams(base,{...common,metrics}),headers).catch(()=>({totals:[]}));
    group.forEach((g,i)=>{const reaches=num(report.totals?.[i]);goals.push({goalId:String(g.id),name:String(g.name||`Цель ${g.id}`),type:String(g.type||''),category:g.category||'other',reaches,visits:totalVisits,conversionRate:totalVisits?reaches/totalVisits*100:0});});
  }
  return { counterId, sources, pages, devices:simple('devices'), regions:simple('regions'), searchEngines:simple('searchEngines'), utm, searchPhrases, goals, warnings };
}

async function webmasterRangeData(env, from, to) {
  const headers = { Authorization: `OAuth ${env.YANDEX_TOKEN}` };
  const user = await apiGet('https://api.webmaster.yandex.net/v4/user', headers);
  const uid = user.user_id || user.userId;
  if (!uid) throw new Error('Вебмастер не вернул user_id');
  const hostId = await resolveWebmasterHostId(env, headers, uid);
  const root = `https://api.webmaster.yandex.net/v4/user/${uid}/hosts/${encodeURIComponent(hostId)}`;
  const a=new Date(`${from}T12:00:00Z`), b=new Date(`${to}T12:00:00Z`), days=Math.floor((b-a)/86400000)+1;
  const prevTo=new Date(a); prevTo.setUTCDate(prevTo.getUTCDate()-1);
  const prevFrom=new Date(prevTo); prevFrom.setUTCDate(prevFrom.getUTCDate()-(days-1));
  const params={order_by:'TOTAL_SHOWS',query_indicator:['TOTAL_SHOWS','TOTAL_CLICKS','AVG_SHOW_POSITION','AVG_CLICK_POSITION'],date_from:from,date_to:to,limit:'500'};
  const [cur, prev] = await Promise.all([
    apiGet(withParams(`${root}/search-queries/popular`,params),headers),
    apiGet(withParams(`${root}/search-queries/popular`,{...params,date_from:dateOnly(prevFrom),date_to:dateOnly(prevTo)}),headers).catch(()=>({queries:[]}))
  ]);
  const prevMap=new Map((prev.queries||[]).map(q=>[q.query_text,q]));
  const seo=(cur.queries||[]).map(q=>{const ind=q.indicators||{},shows=num(ind.TOTAL_SHOWS),clicks=num(ind.TOTAL_CLICKS),position=num(ind.AVG_SHOW_POSITION),clickPosition=num(ind.AVG_CLICK_POSITION),prevPos=num(prevMap.get(q.query_text)?.indicators?.AVG_SHOW_POSITION);return {query:q.query_text,shows,clicks,ctr:shows?clicks/shows*100:0,position,clickPosition,delta:prevPos&&position?prevPos-position:0};});
  return { hostId, seo };
}

async function syncConfigured(env) {
  await ensureExtendedSchema(env);
  const jobs = [];
  const add = (source, fn) => jobs.push([source, fn]);
  if (env.YANDEX_TOKEN && (env.METRIKA_COUNTER_ID || env.SITE_URL)) add('metrika', () => syncMetrika(env));
  if (env.YANDEX_TOKEN && (env.WEBMASTER_HOST_ID || env.SITE_URL)) add('webmaster', () => syncWebmaster(env));
  if (env.YANDEX_TOKEN) add('ybusiness', () => syncYandexBusiness(env));
  if (env.YANDEX_TOKEN) add('direct', () => syncDirect(env));
  if (env.VK_ADS_TOKEN || (env.VK_ADS_CLIENT_ID && env.VK_ADS_CLIENT_SECRET)) add('vkads', () => syncVkAds(env));
  add('vksocial', () => syncVkCommunity(env));
  add('telegram', () => syncTelegram(env));
  add('maxsocial', () => syncMax(env));
  add('dzen', () => syncDzen(env));
  if (env.UNISENDER_API_KEY) add('unisender', () => syncUnisender(env));
  const settled = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  const results = settled.map((r, i) => ({ source: jobs[i][0], ok: r.status === 'fulfilled', message: r.status === 'fulfilled' ? (r.value?.message || 'Обновлено') : (r.reason?.message || String(r.reason || 'Ошибка')) }));
  const ok = results.filter(x => x.ok).length;
  const failed = results.length - ok;
  return { message: `Синхронизация завершена: ${ok} источников обновлено${failed ? `, ${failed} с ошибкой/ограничением` : ''}.`, results };
}

async function syncSource(source, env) {
  await ensureExtendedSchema(env);
  if (source === 'metrika') return syncMetrika(env);
  if (source === 'webmaster') return syncWebmaster(env);
  if (source === 'ybusiness') return syncYandexBusiness(env);
  if (source === 'direct') return syncDirect(env);
  if (source === 'vkads') return syncVkAds(env);
  if (source === 'vksocial') return syncVkCommunity(env);
  if (source === 'telegram') return syncTelegram(env);
  if (source === 'maxsocial') return syncMax(env);
  if (source === 'dzen') return syncDzen(env);
  if (source === 'unisender') return syncUnisender(env);
  throw new Error('Unknown source');
}


/* -------------------- YANDEX METRIKA -------------------- */

async function syncMetrika(env) {
  if (!env.YANDEX_TOKEN) throw new Error('Добавьте YANDEX_TOKEN в Cloudflare Runtime Secrets.');
  const headers = { Authorization: `OAuth ${env.YANDEX_TOKEN}` };
  const counterId = await resolveMetrikaCounterId(env, headers);
  await saveResolved(env, 'metrika', counterId, env.SITE_URL || `Счётчик ${counterId}`);
  const base = 'https://api-metrika.yandex.net/stat/v1/data';
  const common = { ids: counterId, date1: '364daysAgo', date2: 'today', accuracy: 'full', lang: 'ru' };

  const goalsInfo = await apiGet(`https://api-metrika.yandex.net/management/v1/counter/${encodeURIComponent(counterId)}/goals`, headers).catch(() => ({ goals: [] }));
  const goals = (goalsInfo.goals || []).filter(g => g?.status !== 'DELETED');
  const classified = goals.map(g => ({ ...g, category: classifyGoal(g) }));
  const primaryGoals = await resolvePrimaryGoals(env, classified);
  const selected = [primaryGoals.email, primaryGoals.form].filter(Boolean);

  const dailyMetrics = ['ym:s:visits','ym:s:users','ym:s:pageviews','ym:s:bounceRate','ym:s:pageDepth','ym:s:avgVisitDurationSeconds','ym:s:percentNewVisitors','ym:s:anyGoalReaches'];
  const dailyUrl = withParams(base, { ...common, dimensions: 'ym:s:date', metrics: dailyMetrics.join(',') });
  const sourceUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:trafficSourceName', metrics: 'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:anyGoalReaches', sort: '-ym:s:visits', limit: '100' });
  const pageUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:startURL', metrics: 'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds,ym:s:anyGoalReaches', sort: '-ym:s:visits', limit: '1000' });
  const deviceUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:deviceCategory', metrics: 'ym:s:visits,ym:s:users', sort: '-ym:s:visits', limit: '30' });
  const regionUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:regionArea', metrics: 'ym:s:visits,ym:s:users', sort: '-ym:s:visits', limit: '50' });
  const engineUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:searchEngineName', metrics: 'ym:s:visits,ym:s:users', sort: '-ym:s:visits', limit: '50' });
  const utmUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:lastSignUTMSource,ym:s:lastSignUTMMedium,ym:s:lastSignUTMCampaign', metrics: 'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds,ym:s:anyGoalReaches', sort: '-ym:s:visits', limit: '300' });
  const phraseUrl = withParams(base, { ...common, date1: '29daysAgo', dimensions: 'ym:s:lastSignSearchEngineRootName,ym:s:lastSignSearchPhrase', metrics: 'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds', sort: '-ym:s:visits', limit: '200' });

  const results = await Promise.allSettled([
    apiGet(dailyUrl, headers), apiGet(sourceUrl, headers), apiGet(pageUrl, headers),
    apiGet(deviceUrl, headers), apiGet(regionUrl, headers), apiGet(engineUrl, headers), apiGet(utmUrl, headers), apiGet(phraseUrl, headers)
  ]);
  const dailyRes = requiredResult(results[0], 'дневная статистика Метрики');
  const sourceRes = optionalResult(results[1]);
  const pageRes = optionalResult(results[2]);
  const deviceRes = optionalResult(results[3]);
  const regionRes = optionalResult(results[4]);
  const engineRes = optionalResult(results[5]);
  const utmRes = optionalResult(results[6]);
  const phraseRes = optionalResult(results[7]);

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
  // Частичный сбой одного среза Метрики не должен стирать последний успешный результат из D1.
  if ((deviceRes.data || []).length) await replaceSimpleDimension(env, 'device_stats', periodKey, deviceRes.data || []);
  if ((regionRes.data || []).length) await replaceSimpleDimension(env, 'region_stats', periodKey, regionRes.data || []);
  if ((engineRes.data || []).length) await replaceSimpleDimension(env, 'search_engines', periodKey, engineRes.data || []);

  await env.DB.prepare('DELETE FROM utm_stats WHERE period_key=?').bind(periodKey).run();
  for (const row of utmRes.data || []) {
    const source = dimensionName(row.dimensions?.[0]) || '(не задано)';
    const medium = dimensionName(row.dimensions?.[1]) || '(не задано)';
    const campaign = dimensionName(row.dimensions?.[2]) || '(не задано)';
    const m = row.metrics || [];
    if (source === '(не задано)' && medium === '(не задано)' && campaign === '(не задано)') continue;
    await env.DB.prepare(`INSERT INTO utm_stats(period_key,source,medium,campaign,visits,users,bounce,depth,duration,conversions) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(periodKey,source,medium,campaign,num(m[0]),num(m[1]),num(m[2]),num(m[3]),num(m[4]),num(m[5])).run();
  }

  await env.DB.prepare('DELETE FROM search_phrases WHERE period_key=?').bind(periodKey).run();
  for (const row of phraseRes.data || []) {
    const engine = dimensionName(row.dimensions?.[0]) || 'Поиск';
    const phrase = dimensionName(row.dimensions?.[1]) || '';
    const m = row.metrics || [];
    if (!phrase) continue;
    await env.DB.prepare(`INSERT INTO search_phrases(period_key,engine,phrase,visits,users,bounce,depth,duration) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(periodKey,engine,phrase,num(m[0]),num(m[1]),num(m[2]),num(m[3]),num(m[4])).run();
  }

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

  const goalNote = `основная форма: ${primaryGoals.form?.name || 'не выбрана'}; email: ${primaryGoals.email?.name || 'не выбран'}`;
  await logSync(env, 'metrika', 'ok', `Метрика: ${dailyRes.data?.length || 0} дней, ${goals.length} целей, UTM ${utmRes.data?.length || 0}, поисковых фраз ${phraseRes.data?.length || 0}; ${goalNote}`);
  return { message: `Метрика обновлена: ${dailyRes.data?.length || 0} дней. ${goalNote}. Отправки формы и клики email считаются только по одной выбранной основной цели, без суммирования похожих целей.` };
}

function classifyGoal(goal) {
  const type = String(goal?.type || '').toLowerCase();
  const name = String(goal?.name || '').toLowerCase();
  if (type === 'email' || /(e-?mail|почт|mailto)/i.test(name)) return 'email';
  if (/(отправ|заяв|форм|обратн.{0,8}связ|request|application|lead|заказ.{0,8}звон)/i.test(name)) return 'form';
  return 'other';
}


async function resolvePrimaryGoals(env, goals) {
  const settings = await getAppSettings(env);
  const byId = new Map((goals || []).map(g => [String(g.id), g]));
  const scoreForm = g => {
    const n=String(g?.name||'').toLowerCase(),t=String(g?.type||'').toLowerCase(); let s=0;
    if (g?.category==='form') s+=20;
    if (/отправка формы|форма отправлена|успешн.{0,10}форм/i.test(n)) s+=100;
    if (/заявк|обратн.{0,8}связ|lead/i.test(n)) s+=55;
    if (/автоцель/i.test(n)) s+=15;
    if (t==='form') s+=30;
    if (/заказ звон|клик|телефон|email|почт/i.test(n)) s-=50;
    return s;
  };
  const scoreEmail = g => {
    const n=String(g?.name||'').toLowerCase(),t=String(g?.type||'').toLowerCase(); let s=0;
    if (g?.category==='email') s+=30;
    if (/клик.{0,10}(по )?e-?mail|mailto|электронн.{0,10}почт/i.test(n)) s+=100;
    if (t==='email') s+=70;
    if (/отправ|заяв|форм/i.test(n)) s-=40;
    return s;
  };
  const pick=(category,settingKey,scoreFn)=>{
    const configured=String(settings[settingKey]||'');
    if(configured&&byId.has(configured)) return byId.get(configured);
    const candidates=(goals||[]).filter(g=>g.category===category).map(g=>({g,s:scoreFn(g)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s);
    return candidates[0]?.g || null;
  };
  const form=pick('form','primary_form_goal_id',scoreForm);
  const email=pick('email','primary_email_goal_id',scoreEmail);
  if(!settings.primary_form_goal_id&&form) await setAppSetting(env,'primary_form_goal_id',String(form.id));
  if(!settings.primary_email_goal_id&&email) await setAppSetting(env,'primary_email_goal_id',String(email.id));
  return {form,email};
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
  const historyStart = new Date(); historyStart.setDate(historyStart.getDate() - 364);
  const params = { order_by: 'TOTAL_SHOWS', query_indicator: ['TOTAL_SHOWS','TOTAL_CLICKS','AVG_SHOW_POSITION','AVG_CLICK_POSITION'], date_from: dateOnly(start), date_to: dateOnly(end), limit: '500' };

  const [current, prev, summary, diagnostics, indexHistory] = await Promise.all([
    apiGet(withParams(`${root}/search-queries/popular`, params), headers),
    apiGet(withParams(`${root}/search-queries/popular`, { ...params, date_from: dateOnly(prevStart), date_to: dateOnly(prevEnd) }), headers).catch(() => ({ queries: [] })),
    apiGet(`${root}/summary`, headers).catch(() => null),
    apiGet(`${root}/diagnostics`, headers).catch(() => ({ problems: {} })),
    apiGet(withParams(`${root}/search-urls/in-search/history`, { date_from: dateOnly(historyStart), date_to: dateOnly(end) }), headers).catch(() => ({ history: [] }))
  ]);

  // URL-level search visibility for product/catalog pages. This recreates the useful part of
  // Yandex Products «Видимость в Поиске» without a second token: impressions/clicks/CTR/position
  // come from Webmaster; post-click behaviour is joined with Metrica in the UI.
  const productUrlAnalytics = await fetchProductUrlAnalytics(root, headers).catch(() => []);
  await env.DB.prepare(`DELETE FROM product_search_daily WHERE date < date('now','-180 day')`).run().catch(()=>{});
  for (const row of productUrlAnalytics) {
    await env.DB.prepare(`INSERT INTO product_search_daily(url,date,popular_query,impressions,clicks,ctr,position,demand,updated_at) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(url,date) DO UPDATE SET popular_query=excluded.popular_query,impressions=excluded.impressions,clicks=excluded.clicks,ctr=excluded.ctr,position=excluded.position,demand=excluded.demand,updated_at=CURRENT_TIMESTAMP`)
      .bind(row.url,row.date,row.popularQuery||'',num(row.impressions),num(row.clicks),num(row.ctr),num(row.position),num(row.demand)).run();
  }

  const prevByText = new Map((prev.queries || []).map(q => [q.query_text, q]));
  await env.DB.prepare('DELETE FROM seo_queries').run();
  for (const q of current.queries || []) {
    const ind = q.indicators || {};
    const shows = num(ind.TOTAL_SHOWS), clicks = num(ind.TOTAL_CLICKS), position = num(ind.AVG_SHOW_POSITION), clickPosition = num(ind.AVG_CLICK_POSITION);
    const prevQ = prevByText.get(q.query_text), prevPos = num(prevQ?.indicators?.AVG_SHOW_POSITION);
    const delta = prevPos && position ? prevPos - position : 0;
    const ctr = shows ? clicks / shows * 100 : 0;
    await env.DB.prepare(`INSERT INTO seo_queries(query,shows,clicks,ctr,position,click_position,delta,updated_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .bind(q.query_text,shows,clicks,ctr,position,clickPosition,delta).run();
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

  await logSync(env, 'webmaster', 'ok', `Вебмастер: ${current.queries?.length || 0} запросов, ${productUrlAnalytics.length} дневных строк товарных URL, ${Object.keys(diagnostics.problems || {}).length} диагностик`);
  return { message: `Вебмастер обновлён: ${current.queries?.length || 0} запросов, ${new Set(productUrlAnalytics.map(x=>x.url)).size} товарных URL, индексация и диагностика загружены.` };
}


/* -------------------- YANDEX DIRECT -------------------- */

async function syncDirect(env) {
  if (!env.YANDEX_TOKEN) throw new Error('Добавьте YANDEX_TOKEN. Для Директа у этого OAuth-приложения также должен быть одобрен полный доступ к Direct API.');
  const headers = { 'Authorization': `Bearer ${env.YANDEX_TOKEN}`, 'Accept-Language': 'ru', 'Content-Type': 'application/json' };

  const campaignResponse = await fetch('https://api.direct.yandex.com/json/v501/campaigns', {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'get', params: { SelectionCriteria: {}, FieldNames: ['Id','Name','State','Status','StatusPayment','Type'] } })
  });
  if (!campaignResponse.ok) {
    const detail = (await campaignResponse.text()).slice(0,700);
    if ([401,403].includes(campaignResponse.status)) {
      return syncDirectFromMetrika(env, `Direct API ${campaignResponse.status}: заявка на API ещё не одобрена или доступ не активирован`);
    }
    throw new Error(`Direct campaigns API ${campaignResponse.status}: ${detail}`);
  }
  const campaignJson = await campaignResponse.json();
  if (campaignJson.error) {
    const detail = campaignJson.error.error_detail || campaignJson.error.error_string || 'ошибка';
    if (/доступ|access|permission|authorization|авториза/i.test(String(detail))) return syncDirectFromMetrika(env, `Direct API: ${detail}`);
    throw new Error(`Direct campaigns: ${detail}`);
  }
  const campaigns = campaignJson.result?.Campaigns || [];

  await env.DB.prepare(`DELETE FROM ad_campaign_meta WHERE channel='Яндекс Директ'`).run();
  for (const c of campaigns) {
    await env.DB.prepare(`INSERT INTO ad_campaign_meta(channel,campaign_id,name,status,native_state,updated_at) VALUES('Яндекс Директ',?,?,?,?,CURRENT_TIMESTAMP)`)
      .bind(String(c.Id),String(c.Name || `Кампания ${c.Id}`),directStateRu(c.State),String(c.State || c.Status || '')).run();
  }

  const end = new Date(), start = new Date(); start.setDate(start.getDate() - 179);
  const dateFrom=dateOnly(start),dateTo=dateOnly(end);
  const reportBody = { params: {
    SelectionCriteria: { DateFrom: dateFrom, DateTo: dateTo },
    FieldNames: ['Date','CampaignId','CampaignName','Impressions','Clicks','Ctr','Cost','AvgCpc','Conversions','ConversionRate','CostPerConversion','BounceRate','AvgPageviews'],
    ReportName: `CSMarketing-CampaignPerformance-${dateFrom}-${dateTo}`,
    ReportType: 'CAMPAIGN_PERFORMANCE_REPORT', DateRangeType: 'CUSTOM_DATE', Format: 'TSV', IncludeVAT: 'YES', IncludeDiscount: 'YES'
  }};
  const reportHeaders = { ...headers, 'returnMoneyInMicros': 'false', 'processingMode':'auto', 'skipReportHeader':'true', 'skipReportSummary':'true' };
  let res=null;
  for(let attempt=0;attempt<4;attempt++){
    res=await fetch('https://api.direct.yandex.com/json/v501/reports',{method:'POST',headers:reportHeaders,body:JSON.stringify(reportBody)});
    if(res.status!==201&&res.status!==202) break;
    const retryIn=Math.max(1,Number(res.headers.get('retryIn')||60));
    if(retryIn>4||attempt===3){
      await logSync(env,'direct','pending',`Директ: ${campaigns.length} кампаний найдены. Офлайн-отчёт формируется, повтор через ${retryIn} с.`);
      return {message:`Яндекс Директ подключён: ${campaigns.length} кампаний и их статусы уже получены. Статистический отчёт поставлен в очередь; при следующем обновлении приложение повторит ТОТ ЖЕ запрос и заберёт готовый отчёт автоматически.`,pending:true,campaigns:campaigns.length,retryIn};
    }
    await new Promise(r=>setTimeout(r,retryIn*1000));
  }
  if (!res?.ok) { const detail=(await res.text()).slice(0,500); if([401,403].includes(res.status)) return syncDirectFromMetrika(env, `Direct Reports API ${res.status}`); throw new Error(`Direct Reports API ${res.status}: ${detail}`); }
  const rows = parseDirectTsv(await res.text());
  await env.DB.prepare(`DELETE FROM ad_campaign_daily WHERE channel='Яндекс Директ'`).run();
  const metaById = new Map(campaigns.map(c => [String(c.Id), c]));
  for (const r of rows) {
    const id = String(r.CampaignId || ''); if (!id || !r.Date) continue;
    const c = metaById.get(id);
    const name = r.CampaignName || c?.Name || `Кампания ${id}`;
    await env.DB.prepare(`INSERT INTO ad_campaign_daily(channel,campaign_id,name,date,impressions,clicks,spend,conversions,bounce_rate,avg_pageviews) VALUES('Яндекс Директ',?,?,?,?,?,?,?,?,?)
      ON CONFLICT(channel,campaign_id,date) DO UPDATE SET name=excluded.name,impressions=excluded.impressions,clicks=excluded.clicks,spend=excluded.spend,conversions=excluded.conversions,bounce_rate=excluded.bounce_rate,avg_pageviews=excluded.avg_pageviews`)
      .bind(id,name,r.Date,num(r.Impressions),num(r.Clicks),num(r.Cost),num(r.Conversions),num(r.BounceRate),num(r.AvgPageviews)).run();
  }
  await logSync(env,'direct','ok',`Директ: ${campaigns.length} кампаний, ${rows.length} строк статистики`);
  return { message: `Яндекс Директ обновлён: ${campaigns.length} кампаний, ${rows.length} дневных строк. Расходы берутся только из API.` };
}


async function syncDirectFromMetrika(env, reason='Direct API недоступен') {
  const headers = { Authorization: `OAuth ${env.YANDEX_TOKEN}` };
  const counterId = await resolveMetrikaCounterId(env, headers);
  const goalsInfo = await apiGet(`https://api-metrika.yandex.net/management/v1/counter/${encodeURIComponent(counterId)}/goals`, headers).catch(()=>({goals:[]}));
  const classified=(goalsInfo.goals||[]).filter(g=>g?.status!=='DELETED').map(g=>({...g,category:classifyGoal(g)}));
  const primary=await resolvePrimaryGoals(env,classified);
  const goalMetric=primary.form ? `ym:ad:goal${primary.form.id}reaches` : 'ym:ad:anyGoalReaches';
  const clientsData = await apiGet(withParams('https://api-metrika.yandex.net/management/v1/clients',{counters:counterId}),headers).catch(()=>({clients:[]}));
  const directLogins = (clientsData.clients||[]).map(x=>String(x.chief_login||'').trim()).filter(Boolean);
  if (!directLogins.length) throw new Error(`${reason}. Метрика не вернула ни одного доступного логина Директа для счётчика ${counterId}. Проверьте связь Метрики с рекламным кабинетом.`);
  const url=withParams('https://api-metrika.yandex.net/stat/v1/data/bytime',{
    ids:counterId,date1:'364daysAgo',date2:'today',group:'day',accuracy:'full',lang:'ru',currency:'RUB',top_keys:'30',
    direct_client_logins:directLogins.join(','),
    dimensions:'ym:ad:lastSignDirectOrder',
    metrics:`ym:ad:clicks,ym:ad:RUBConvertedAdCost,${goalMetric},ym:ad:bounceRate,ym:ad:pageDepth`
  });
  const report=await apiGet(url,headers);
  const intervals=Array.isArray(report.time_intervals)?report.time_intervals:[];
  await env.DB.prepare(`DELETE FROM ad_campaign_meta WHERE channel='Яндекс Директ'`).run();
  await env.DB.prepare(`DELETE FROM ad_campaign_daily WHERE channel='Яндекс Директ'`).run();
  let rows=0;
  for(const item of report.data||[]){
    const dim=item.dimensions?.[0]||{}; const id=String(dim.id||await shortHash(dim.name||'direct')); const name=String(dim.name||`Кампания ${id}`);
    const metrics=item.metrics||[]; const clicks=metrics[0]||[], costs=metrics[1]||[], convs=metrics[2]||[], bounce=metrics[3]||[], depth=metrics[4]||[];
    let recent=false;
    for(let i=0;i<Math.max(clicks.length,costs.length,convs.length);i++){
      const date=String(intervals[i]?.[0]||'').slice(0,10); if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const c=num(clicks[i]),sp=num(costs[i]),cv=num(convs[i]); if(c||sp||cv) rows++;
      const age=(Date.now()-new Date(`${date}T12:00:00Z`).getTime())/86400000; if(age<=7&&(c||sp))recent=true;
      await env.DB.prepare(`INSERT INTO ad_campaign_daily(channel,campaign_id,name,date,impressions,clicks,spend,conversions,bounce_rate,avg_pageviews) VALUES('Яндекс Директ',?,?,?,?,?,?,?,?,?)
        ON CONFLICT(channel,campaign_id,date) DO UPDATE SET name=excluded.name,clicks=excluded.clicks,spend=excluded.spend,conversions=excluded.conversions,bounce_rate=excluded.bounce_rate,avg_pageviews=excluded.avg_pageviews`)
        .bind(id,name,date,0,c,sp,cv,num(bounce[i]),num(depth[i])).run();
    }
    await env.DB.prepare(`INSERT INTO ad_campaign_meta(channel,campaign_id,name,status,native_state,updated_at) VALUES('Яндекс Директ',?,?,?,?,CURRENT_TIMESTAMP)`)
      .bind(id,name,recent?'active':'unknown','METRIKA_FALLBACK').run();
  }
  const msg=`Яндекс Директ: прямой API пока недоступен (${reason}). Через Метрику (${directLogins.join(', ')}) загружены реальные клики, расходы и цели из отчёта «Директ, расходы»: ${report.data?.length||0} кампаний, ${rows} дневных строк. Показы и нативный статус появятся после одобрения Direct API.`;
  await logSync(env,'direct','partial',msg);
  return {message:msg,fallback:true};
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
    throw new Error('Добавьте VK_ADS_CLIENT_ID и VK_ADS_CLIENT_SECRET в Cloudflare Runtime Variables/Secrets. Access token приложение получает само.');
  }
  // Проверяем именно рекламный OAuth отдельно от VK-сообщества.
  const accountInfo = await vkAdsGet(env, 'https://ads.vk.com/api/v3/user.json').catch(() => null);
  const budgetInfo = await vkAdsGet(env, 'https://ads.vk.com/api/v2/budget.json').catch(() => null);

  const campaigns = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    const page = await vkAdsGet(env, withParams('https://ads.vk.com/api/v2/ad_plans.json', { limit: 50, offset, fields: 'id,name,status' }));
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

  const end = new Date(), start = new Date(); start.setDate(start.getDate() - 364);
  const ids = campaigns.map(c => c?.id).filter(Boolean).map(String);
  const allRows = [];
  for (const group of chunks(ids, 200)) {
    if (!group.length) continue;
    const url = withParams('https://ads.vk.com/api/v2/statistics/ad_plans/day.json', {
      id: group.join(','), date_from: dateOnly(start), date_to: dateOnly(end), metrics: 'base'
    });
    const payload = await vkAdsGet(env, url).catch(err => ({ __error: err.message }));
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
  const accountLabel = String(accountInfo?.username || accountInfo?.email || accountInfo?.id || '').trim();
  const budgetValue = num(budgetInfo?.balance ?? budgetInfo?.budget ?? budgetInfo?.available ?? budgetInfo?.amount);
  const extra = [accountLabel && `кабинет ${accountLabel}`, budgetValue ? `доступный бюджет ${budgetValue.toFixed(2)} ₽` : ''].filter(Boolean).join(', ');
  await logSync(env, 'vkads', 'ok', `VK Реклама: ${campaigns.length} кампаний, ${allRows.length} дневных строк${extra ? `, ${extra}` : ''}. OAuth-токен обновляется автоматически.`);
  return { message: `VK Реклама обновлена отдельно от сообщества: ${campaigns.length} кампаний, ${allRows.length} строк статистики${extra ? `; ${extra}` : ''}. Временный access token управляется приложением автоматически.` };
}

async function getVkAdsToken(env, force = false) {
  if (!(env.VK_ADS_CLIENT_ID && env.VK_ADS_CLIENT_SECRET)) {
    if (env.VK_ADS_TOKEN) return String(env.VK_ADS_TOKEN);
    throw new Error('VK Ads OAuth: отсутствуют VK_ADS_CLIENT_ID/VK_ADS_CLIENT_SECRET.');
  }
  if (!force) {
    const cached = await readIntegrationCache(env, 'vkads_oauth').catch(() => null);
    if (cached?.accessToken && num(cached.expiresAt) > Date.now() + 60_000) return String(cached.accessToken);
  }
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
  const ttl = Math.max(300, num(data.expires_in) || 86400);
  const record = { accessToken: String(data.access_token), expiresAt: Date.now() + ttl * 1000 };
  await writeIntegrationCache(env, 'vkads_oauth', record, record.expiresAt).catch(() => {});
  return record.accessToken;
}

async function vkAdsGet(env, url) {
  const run = async (force = false) => {
    const token = await getVkAdsToken(env, force);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'ru' } });
    const text = await res.text();
    let data = {}; try { data = JSON.parse(text); } catch {}
    return { res, text, data };
  };
  let result = await run(false);
  if (result.res.status === 401 && env.VK_ADS_CLIENT_ID && env.VK_ADS_CLIENT_SECRET) {
    await deleteIntegrationCache(env, 'vkads_oauth').catch(() => {});
    result = await run(true);
  }
  if (!result.res.ok) throw new Error(`VK Ads API ${result.res.status}: ${result.data?.error?.message || result.data?.error_description || result.text.slice(0,400)}`);
  return result.data;
}

async function readIntegrationCache(env, key) {
  const row = await env.DB.prepare(`SELECT value_json AS valueJson,expires_at AS expiresAt FROM integration_cache WHERE cache_key=?`).bind(key).first();
  if (!row?.valueJson) return null;
  const value = JSON.parse(row.valueJson);
  if (row.expiresAt && !value.expiresAt) value.expiresAt = row.expiresAt;
  return value;
}
async function writeIntegrationCache(env, key, value, expiresAt = 0) {
  return env.DB.prepare(`INSERT INTO integration_cache(cache_key,value_json,expires_at,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json,expires_at=excluded.expires_at,updated_at=CURRENT_TIMESTAMP`)
    .bind(key, JSON.stringify(value), Math.round(num(expiresAt))).run();
}
async function deleteIntegrationCache(env, key) { return env.DB.prepare(`DELETE FROM integration_cache WHERE cache_key=?`).bind(key).run(); }

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


/* -------------------- VK COMMUNITY -------------------- */

async function syncVkCommunity(env) {
  const communityToken = String(env.VK_COMMUNITY_TOKEN || '').trim();
  const readToken = String(env.VK_SERVICE_TOKEN || env.VK_USER_TOKEN || '').trim();
  const group = await resolveVkCommunityHybrid(env, communityToken);
  const groupId = group?.id ? String(group.id) : '';
  const groupName = String(group?.name || group?.screen_name || 'VK-сообщество');
  if (groupId) await saveResolved(env, 'vksocial', groupId, groupName);

  // ВАЖНО: wall.get не вызывается с VK_COMMUNITY_TOKEN (group auth).
  // Посты читаем либо отдельным service/user token, либо best-effort с публичной страницы.
  let posts = [];
  let postsSource = 'none';
  let postsNote = '';
  if (readToken && groupId) {
    try {
      const wall = await vkApi('wall.get', { owner_id: `-${groupId}`, count: 100, filter: 'owner', extended: 0 }, readToken);
      posts = normalizeVkApiPosts(wall, groupId, group?.members_count);
      postsSource = 'vk-api';
    } catch (err) {
      postsNote = `VK API для постов недоступен: ${err?.message || err}`;
    }
  }

  if (!posts.length) {
    try {
      posts = await fetchVkPublicPosts(env, group);
      if (posts.length) postsSource = 'public-web';
    } catch (err) {
      postsNote = postsNote || `Публичная страница VK не отдала посты: ${err?.message || err}`;
    }
  }

  if (posts.length) {
    await env.DB.prepare(`DELETE FROM social_posts WHERE channel='VK'`).run();
    for (const post of posts) {
      await env.DB.prepare(`INSERT INTO social_posts(channel,title,date,reach,views,reactions,comments,shares,clicks,followers,followers_delta,post_id,post_url,media_type,text_length,updated_at)
        VALUES('VK',?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(channel,title,date) DO UPDATE SET reach=excluded.reach,views=excluded.views,reactions=excluded.reactions,comments=excluded.comments,shares=excluded.shares,clicks=excluded.clicks,followers=excluded.followers,followers_delta=excluded.followers_delta,post_id=excluded.post_id,post_url=excluded.post_url,media_type=excluded.media_type,text_length=excluded.text_length,updated_at=CURRENT_TIMESTAMP`)
        .bind(post.title,post.date,num(post.reach),num(post.views),num(post.reactions),num(post.comments),num(post.shares),num(post.clicks),num(post.followers),num(post.followersDelta),String(post.postId||''),String(post.postUrl||''),String(post.mediaType||'text'),num(post.textLength)).run();
    }
  }

  // Group-level stats are independent from wall.get. If group auth allows stats.get, keep them.
  let statsRows = 0;
  let statsNote = '';
  if (communityToken && groupId) {
    const end = new Date();
    const start = new Date(); start.setDate(start.getDate() - 364);
    try {
      const stats = await vkApi('stats.get', {
        group_id: groupId,
        timestamp_from: Math.floor(start.getTime()/1000),
        timestamp_to: Math.floor((end.getTime()+86399000)/1000),
        interval: 'day',
        stats_groups: 'visitors,reach,activity'
      }, communityToken);
      await env.DB.prepare(`DELETE FROM social_channel_daily WHERE channel='VK'`).run();
      if (Array.isArray(stats)) {
        for (const row of stats) {
          const rawDate = row?.period_from ?? row?.timestamp_from ?? row?.date;
          const stamp = num(rawDate);
          const date = stamp > 1000000000 ? dateOnly(new Date(stamp * 1000)) : String(rawDate || '').slice(0,10);
          if (!date) continue;
          const visitorsBlock = row?.visitors || {};
          const reachBlock = row?.reach || {};
          const activity = row?.activity || {};
          const views = num(visitorsBlock.views ?? row?.views);
          const visitors = num(visitorsBlock.visitors ?? row?.visitors_count);
          const reach = num(reachBlock.reach ?? reachBlock.total_reach ?? row?.reach_count ?? (typeof row?.reach === 'number' ? row.reach : 0));
          const subscribersReach = num(reachBlock.reach_subscribers ?? reachBlock.subscribers_reach);
          const subscribed = num(activity.subscribed ?? visitorsBlock.subscribed ?? row?.subscribed);
          const unsubscribed = num(activity.unsubscribed ?? visitorsBlock.unsubscribed ?? row?.unsubscribed);
          const likes = num(activity.likes ?? row?.likes);
          const comments = num(activity.comments ?? row?.comments);
          const shares = num(activity.copies ?? activity.reposts ?? row?.shares);
          await env.DB.prepare(`INSERT INTO social_channel_daily(channel,date,views,visitors,reach,subscribers_reach,subscribed,unsubscribed,likes,comments,shares)
            VALUES('VK',?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(channel,date) DO UPDATE SET views=excluded.views,visitors=excluded.visitors,reach=excluded.reach,subscribers_reach=excluded.subscribers_reach,subscribed=excluded.subscribed,unsubscribed=excluded.unsubscribed,likes=excluded.likes,comments=excluded.comments,shares=excluded.shares`)
            .bind(date,views,visitors,reach,subscribersReach,subscribed,unsubscribed,likes,comments,shares).run();
          statsRows++;
        }
      }
    } catch (err) {
      statsNote = `Статистика сообщества недоступна: ${err?.message || err}`;
    }
  }

  const parts = [];
  if (posts.length) parts.push(`${posts.length} постов (${postsSource === 'vk-api' ? 'VK API' : 'публичная страница'})`);
  else parts.push('посты не загружены');
  if (statsRows) parts.push(`${statsRows} дней статистики сообщества`);
  const details = [postsNote, statsNote].filter(Boolean).join(' ');
  const status = (posts.length || statsRows) ? (posts.length && statsRows ? 'ok' : 'partial') : 'partial';
  const message = `VK Контент: ${parts.join(', ')}.${details ? ` ${details}` : ''} VK Реклама синхронизируется отдельно и от этого блока не зависит.`;
  await logSync(env, 'vksocial', status, message);
  return { message };
}

function normalizeVkApiPosts(wall, groupId, followers = 0) {
  const items = Array.isArray(wall?.items) ? wall.items : [];
  return items.map(post => {
    const d = new Date(num(post?.date) * 1000);
    if (Number.isNaN(d.getTime())) return null;
    const text = String(post?.text || '').replace(/\s+/g, ' ').trim();
    const title = text ? text.slice(0, 140) : `Пост VK ${post?.id || post?.date}`;
    const attachments = Array.isArray(post?.attachments) ? post.attachments : [];
    const mediaType = attachments.some(a=>a?.type==='video') ? 'video' : attachments.some(a=>a?.type==='photo') ? 'image' : attachments.some(a=>a?.type==='poll') ? 'poll' : 'text';
    return {
      title, date: dateOnly(d), reach: 0, views: num(post?.views?.count), reactions: num(post?.likes?.count), comments: num(post?.comments?.count), shares: num(post?.reposts?.count), clicks: 0,
      followers: num(followers), followersDelta: 0, postId: String(post?.id || ''), postUrl: `https://vk.com/wall-${groupId}_${post?.id}`, mediaType, textLength: text.length
    };
  }).filter(Boolean);
}

async function resolveVkCommunityHybrid(env, token) {
  const explicitId = String(env.VK_GROUP_ID || '').replace(/^-/,'').trim();
  const explicitUrl = String(env.VK_COMMUNITY_URL || DEFAULT_SOCIAL_URLS.vk).trim();
  const screenFromUrl = vkScreenNameFromUrl(explicitUrl);

  if (token) {
    if (explicitId) {
      const response = await vkApi('groups.getById', { group_ids: explicitId, fields: 'members_count,screen_name' }, token).catch(() => null);
      const items = Array.isArray(response?.groups) ? response.groups : Array.isArray(response) ? response : [];
      if (items[0]?.id) return items[0];
    }
    if (screenFromUrl) {
      const response = await vkApi('groups.getById', { group_ids: screenFromUrl, fields: 'members_count,screen_name' }, token).catch(() => null);
      const items = Array.isArray(response?.groups) ? response.groups : Array.isArray(response) ? response : [];
      if (items[0]?.id) return items[0];
    }
    const auto = await vkApi('groups.getById', { fields: 'members_count,screen_name' }, token).catch(() => null);
    const autoItems = Array.isArray(auto?.groups) ? auto.groups : Array.isArray(auto) ? auto : [];
    if (autoItems.length === 1 && autoItems[0]?.id) return autoItems[0];
  }

  if (explicitId || screenFromUrl) return { id: explicitId || null, name: screenFromUrl || `VK ${explicitId}`, screen_name: screenFromUrl || '' };
  throw new Error('Не удалось определить VK-сообщество. Добавьте VK_GROUP_ID или VK_COMMUNITY_URL. Это не влияет на VK Рекламу.');
}

function vkScreenNameFromUrl(value) {
  if (!value) return '';
  try {
    const u = new URL(value.startsWith('http') ? value : `https://vk.com/${value.replace(/^\/+/, '')}`);
    return u.pathname.replace(/^\/+|\/+$/g,'').split('/')[0] || '';
  } catch { return String(value).replace(/^@|^https?:\/\/(?:m\.)?vk\.com\//i,'').split(/[/?#]/)[0]; }
}

async function fetchVkPublicPosts(env, group) {
  const screen = vkScreenNameFromUrl(env.VK_COMMUNITY_URL || DEFAULT_SOCIAL_URLS.vk) || String(group?.screen_name || '').trim();
  const groupId = String(group?.id || env.VK_GROUP_ID || '').replace(/^-/,'');
  const targets = [];
  if (screen) targets.push(`https://m.vk.com/${encodeURIComponent(screen)}`,`https://vk.com/${encodeURIComponent(screen)}`,`https://vk.ru/${encodeURIComponent(screen)}`);
  else if (groupId) targets.push(`https://m.vk.com/club${encodeURIComponent(groupId)}`,`https://vk.com/club${encodeURIComponent(groupId)}`);
  let lastError = '';
  for (const target of targets) {
    try {
      const res = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36', 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.6', Accept:'text/html,application/xhtml+xml' }, redirect: 'follow' });
      const html = await res.text();
      if (!res.ok) { lastError=`HTTP ${res.status}`; continue; }
      const structured = parseStructuredPublicPosts(html,{channel:'VK',baseUrl:res.url||target,maxPosts:100});
      const classic = parseVkPublicHtml(html, groupId, num(group?.members_count));
      const posts = classic.length ? classic : structured;
      if (posts.length) return posts.map(x=>({...x,followers:num(x.followers)||num(group?.members_count)}));
      if (/captcha|security check|login_form|blocked|войдите/i.test(html)) lastError='VK запросил авторизацию/проверку вместо публичной стены';
      else lastError='публичная страница открылась, но лента не распознана';
    } catch (e) { lastError=String(e?.message||e); }
  }
  throw new Error(lastError || 'VK не отдал публичную ленту');
}

function parseVkPublicHtml(html, knownGroupId = '', followers = 0) {
  // Best-effort parser. We only save values explicitly present in public HTML; missing metrics stay 0.
  const decoded = decodeHtmlEntities(String(html || ''));
  const postRe = /(?:wall|data-post-id=["']?)(-?\d+)_([0-9]+)/ig;
  const hits = [];
  let m;
  while ((m = postRe.exec(decoded)) && hits.length < 120) {
    const owner = String(m[1]).replace(/^-/,'');
    const postId = String(m[2]);
    if (knownGroupId && owner !== String(knownGroupId)) continue;
    if (!hits.some(x=>x.postId===postId)) hits.push({ owner, postId, index:m.index });
  }
  const out = [];
  for (let i=0;i<hits.length && out.length<100;i++) {
    const h=hits[i];
    const from=Math.max(0,h.index-2500), to=Math.min(decoded.length,(hits[i+1]?.index||h.index+12000));
    const chunk=decoded.slice(from,to);
    const unix = firstRegexNumber(chunk, /(?:data-time|data-date|unixtime)[=:\"'\s]+(\d{10})/i);
    const isoDate = firstRegexText(chunk, /datetime=["'](\d{4}-\d{2}-\d{2})/i);
    const d = unix ? new Date(unix*1000) : isoDate ? new Date(`${isoDate}T12:00:00`) : null;
    if (!d || Number.isNaN(d.getTime())) continue;
    const textHtml = firstRegexText(chunk, /(?:wall_post_text|pi_text|post__text)[^>]*>([\s\S]*?)(?:<\/div>|<\/p>)/i) || '';
    const text = stripTags(textHtml).replace(/\s+/g,' ').trim();
    const title = text ? text.slice(0,140) : `Пост VK ${h.postId}`;
    const views = parseCompactNumber(firstRegexText(chunk, /(?:like_views|views_count|post_views)[^>]*>\s*([^<]+)/i));
    const reactions = parseCompactNumber(firstRegexText(chunk, /(?:like_count|likes_count|_like_count)[^>]*>\s*([^<]+)/i));
    const comments = parseCompactNumber(firstRegexText(chunk, /(?:comment_count|comments_count)[^>]*>\s*([^<]+)/i));
    const shares = parseCompactNumber(firstRegexText(chunk, /(?:repost_count|share_count|reposts_count)[^>]*>\s*([^<]+)/i));
    const mediaType = /video/i.test(chunk) ? 'video' : /photo|image/i.test(chunk) ? 'image' : /poll/i.test(chunk) ? 'poll' : 'text';
    out.push({ title,date:dateOnly(d),reach:0,views,reactions,comments,shares,clicks:0,followers,followersDelta:0,postId:h.postId,postUrl:`https://vk.com/wall-${h.owner}_${h.postId}`,mediaType,textLength:text.length });
  }
  return out;
}

function firstRegexText(value, re) { const m=String(value||'').match(re); return m ? String(m[1]||'').trim() : ''; }
function firstRegexNumber(value, re) { const x=Number(firstRegexText(value,re)); return Number.isFinite(x) ? x : 0; }
function stripTags(value) { return decodeHtmlEntities(String(value||'').replace(/<br\s*\/?\s*>/gi,' ').replace(/<[^>]+>/g,' ')); }
function decodeHtmlEntities(value) { return String(value||'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>'); }

async function resolveVkCommunity(env, token) {
  return resolveVkCommunityHybrid(env, token);
}

async function vkApi(method, params, token) {
  const body = new URLSearchParams();
  for (const [k,v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
  body.set('access_token', token);
  body.set('v', '5.199');
  const res = await fetch(`https://api.vk.com/method/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: body.toString()
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`VK API ${method} ${res.status}: ${text.slice(0,400)}`);
  if (data?.error) throw new Error(`VK API ${method}: ${data.error.error_msg || data.error.error_code || 'ошибка'}`);
  return data?.response;
}


/* -------------------- TELEGRAM PUBLIC CHANNEL -------------------- */

async function syncTelegram(env) {
  const source = String(env.TELEGRAM_CHANNEL_URL || env.TELEGRAM_CHANNEL_USERNAME || DEFAULT_SOCIAL_URLS.telegram).trim();
  const info = telegramChannelInfo(source);
  const posts = new Map();
  let before = null;
  let followers = 0;
  for (let page = 0; page < 5; page++) {
    const url = `${info.previewUrl}${before ? `?before=${encodeURIComponent(before)}` : ''}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CSMarketing/1.1)', 'Accept-Language': 'ru,en;q=0.8' } });
    const html = await res.text();
    if (!res.ok) throw new Error(`Telegram web-preview ${res.status}: ${html.slice(0,220)}`);
    if (!followers) followers = parseCompactNumber(firstMatch(html, /counter_value[^>]*>([^<]+)/i) || firstMatch(html, /([\d.,]+\s*[KMB]?)\s+subscribers/i));
    const batch = parseTelegramHtml(html, info.username, followers);
    if (!batch.length) break;
    batch.forEach(x => posts.set(x.postId || `${x.date}|${x.title}`, x));
    const ids = batch.map(x => Number(String(x.postId || '').split('/').pop())).filter(Number.isFinite);
    if (!ids.length) break;
    const next = String(Math.min(...ids));
    if (before === next) break;
    before = next;
    if (batch.length < 10) break;
  }

  if (!posts.size) {
    const message = 'Telegram: публичная страница не отдала распознаваемые посты. Последняя успешная история сохранена без изменений.';
    await logSync(env,'telegram','partial',message);
    return { message };
  }
  await env.DB.prepare(`DELETE FROM social_posts WHERE channel='Telegram'`).run();
  await env.DB.prepare(`DELETE FROM social_channel_daily WHERE channel='Telegram'`).run();
  const daily = new Map();
  for (const post of [...posts.values()]) {
    await env.DB.prepare(`INSERT INTO social_posts(channel,title,date,reach,views,reactions,comments,shares,clicks,followers,followers_delta,post_id,post_url,media_type,text_length,updated_at)
      VALUES('Telegram',?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(channel,title,date) DO UPDATE SET views=excluded.views,reactions=excluded.reactions,comments=excluded.comments,shares=excluded.shares,followers=excluded.followers,post_id=excluded.post_id,post_url=excluded.post_url,media_type=excluded.media_type,text_length=excluded.text_length,updated_at=CURRENT_TIMESTAMP`)
      .bind(post.title,post.date,0,post.views,post.reactions,post.comments,post.shares,0,followers,0,post.postId,post.postUrl,post.mediaType,post.textLength).run();
    const d = daily.get(post.date) || { views: 0, likes: 0, comments: 0, shares: 0 };
    d.views += post.views; d.likes += post.reactions; d.comments += post.comments; d.shares += post.shares; daily.set(post.date,d);
  }
  for (const [date,d] of daily) await env.DB.prepare(`INSERT INTO social_channel_daily(channel,date,views,visitors,reach,subscribers_reach,subscribed,unsubscribed,likes,comments,shares)
      VALUES('Telegram',?, ?,0,0,0,0,0,?,?,?) ON CONFLICT(channel,date) DO UPDATE SET views=excluded.views,likes=excluded.likes,comments=excluded.comments,shares=excluded.shares`)
      .bind(date,d.views,d.likes,d.comments,d.shares).run();
  await saveResolved(env, 'telegram', info.username, `@${info.username}`);
  const message = `Telegram: загружено ${posts.size} публичных постов${followers ? `, подписчиков ${followers}` : ''}. Просмотры берутся из публичной web-версии; часть реакций/комментариев Telegram публично не показывает.`;
  await logSync(env,'telegram',posts.size?'ok':'partial',message);
  return { message };
}

function telegramChannelInfo(raw) {
  let value = String(raw || '').trim();
  value = value.replace(/^@/, '');
  let username = value;
  try {
    if (/^https?:\/\//i.test(value)) {
      const u = new URL(value);
      const parts = u.pathname.split('/').filter(Boolean);
      username = parts[0] === 's' ? parts[1] : parts[0];
    }
  } catch {}
  username = String(username || '').replace(/^@/,'').replace(/[^A-Za-z0-9_]/g,'');
  if (!username) throw new Error('TELEGRAM_CHANNEL_URL не похож на публичный Telegram-канал.');
  return { username, previewUrl: `https://t.me/s/${username}` };
}

function parseTelegramHtml(html, username, followers = 0) {
  const matches = [...String(html).matchAll(/data-post="([^"]+)"/g)];
  const out = [];
  for (let i=0;i<matches.length;i++) {
    const m=matches[i], next=matches[i+1];
    const block=html.slice(m.index, next ? next.index : Math.min(html.length, m.index+30000));
    const postId=String(m[1]||'');
    const dateRaw=firstMatch(block, /<time[^>]+datetime="([^"]+)"/i);
    const date=dateRaw ? String(dateRaw).slice(0,10) : '';
    if (!date) continue;
    const rawText=firstMatch(block, /tgme_widget_message_text[^>]*>([\s\S]*?)(?:<\/div>\s*<div class="tgme_widget_message_footer|<\/div>\s*<a class="tgme_widget_message_date)/i) || '';
    const text=stripHtml(rawText).replace(/\s+/g,' ').trim();
    const views=parseCompactNumber(firstMatch(block, /tgme_widget_message_views[^>]*>([^<]+)/i));
    const comments=parseCompactNumber(firstMatch(block, /tgme_widget_message_comments[^>]*>[\s\S]*?<span[^>]*>([^<]+)/i));
    const reactionParts=[...block.matchAll(/tgme_widget_message_reaction[^>]*>[\s\S]*?(?:count|counter)[^>]*>([^<]+)/gi)].map(x=>parseCompactNumber(x[1]));
    const reactions=reactionParts.reduce((a,b)=>a+b,0);
    const mediaType=/tgme_widget_message_video|video_player/i.test(block)?'video':/tgme_widget_message_photo|background-image/i.test(block)?'image':/tgme_widget_message_poll/i.test(block)?'poll':'text';
    const title=text ? text.slice(0,180) : `Пост Telegram ${postId.split('/').pop()}`;
    out.push({ postId, postUrl:`https://t.me/${postId}`, title, date, views, reactions, comments, shares:0, followers, mediaType, textLength:text.length });
  }
  return out;
}

/* -------------------- MAX CHANNEL -------------------- */

async function syncMax(env) {
  // If Bot API is configured, prefer it. Otherwise use the public business-channel page.
  if (env.MAX_BOT_TOKEN && env.MAX_CHANNEL_ID) {
    try { return await syncMaxApi(env); }
    catch (err) {
      const fallback = await syncMaxPublic(env).catch(() => null);
      if (fallback) return fallback;
      throw err;
    }
  }
  return syncMaxPublic(env);
}

async function syncMaxApi(env) {
  const url = withParams('https://platform-api2.max.ru/messages', { chat_id: String(env.MAX_CHANNEL_ID), count: 100 });
  const res = await fetch(url, { headers: { Authorization: String(env.MAX_BOT_TOKEN), Accept: 'application/json' } });
  const text = await res.text(); let data = {}; try { data=JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`MAX API ${res.status}: ${data?.message || data?.error || text.slice(0,350)}`);
  const messages = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [];
  const posts = [];
  for (const m of messages) {
    const stamp=num(m?.timestamp); if(!stamp) continue;
    const date=dateOnly(new Date(stamp));
    const textBody=String(m?.body?.text || '').replace(/\s+/g,' ').trim();
    const mid=String(m?.body?.mid || m?.mid || m?.message_id || m?.id || `${stamp}`);
    const stat=m?.stat || {};
    const views=num(stat.views ?? stat.view_count ?? stat.views_count ?? stat.viewers);
    const shares=num(stat.reposts ?? stat.repost_count ?? stat.reposts_count ?? stat.shares);
    const attachments=Array.isArray(m?.body?.attachments)?m.body.attachments:[];
    const mediaType=attachments.some(a=>String(a?.type).toLowerCase().includes('video'))?'video':attachments.some(a=>['image','photo'].includes(String(a?.type).toLowerCase()))?'image':attachments.length?'attachment':'text';
    posts.push({ title:textBody ? textBody.slice(0,180) : `Пост MAX ${mid}`, date, reach:0, views, reactions:0, comments:0, shares, clicks:0, followers:0, followersDelta:0, postId:mid, postUrl:String(m?.url||''), mediaType, textLength:textBody.length });
  }
  await replaceSocialPosts(env,'MAX',posts);
  await saveResolved(env,'maxsocial',String(env.MAX_CHANNEL_ID),'MAX channel');
  const message=`MAX: загружено ${posts.length} постов через Bot API. Просмотры и репосты обновляются автоматически.`;
  await logSync(env,'maxsocial',posts.length?'ok':'partial',message);
  return { message };
}

async function syncMaxPublic(env) {
  const url = String(env.MAX_CHANNEL_URL || DEFAULT_SOCIAL_URLS.max).trim();
  const { html, finalUrl } = await fetchPublicHtml(url, 'MAX');
  const posts = parseStructuredPublicPosts(html, { channel:'MAX', baseUrl:finalUrl || url, hostPattern:/max\.ru/i, maxPosts:100 });
  await replaceSocialPosts(env,'MAX',posts);
  const message = posts.length
    ? `MAX: публичная проверка загрузила ${posts.length} публикаций. Метрики берутся только из значений, реально присутствующих на публичной странице.`
    : 'MAX: публичная страница открылась, но не отдала распознаваемую ленту постов. Другие соцсети продолжают синхронизироваться.';
  await logSync(env,'maxsocial',posts.length?'ok':'partial',message);
  return { message };
}

/* -------------------- DZEN PUBLIC CHANNEL -------------------- */

async function syncDzen(env) {
  const url = String(env.DZEN_CHANNEL_URL || DEFAULT_SOCIAL_URLS.dzen).trim();
  const { html, finalUrl } = await fetchPublicHtml(url, 'Дзен');
  let posts = parseStructuredPublicPosts(html, { channel:'Дзен', baseUrl:finalUrl || url, hostPattern:/dzen\.ru/i, maxPosts:120 });
  let source = posts.length ? 'публичная страница' : '';
  if (!posts.length) {
    const channelId = extractDzenChannelId(html, finalUrl || url);
    if (channelId) {
      const apiPosts = await fetchDzenLauncherPosts(channelId, finalUrl || url).catch(()=>[]);
      if (apiPosts.length) { posts = apiPosts; source='публичный JSON Дзена'; }
    }
  }
  await replaceSocialPosts(env,'Дзен',posts);
  const message = posts.length
    ? `Дзен: загружено ${posts.length} публикаций (${source}). Просмотры/реакции сохраняются только когда они реально присутствуют в публичном ответе.`
    : 'Дзен: канал открыт, но текущая публичная разметка не отдала распознаваемую ленту. Последняя успешная история сохранена и не заменяется нулями.';
  await logSync(env,'dzen',posts.length?'ok':'partial',message);
  return { message };
}

function extractDzenChannelId(html, url='') {
  const text=String(html||'');
  const patterns=[/"channel[_-]?id"\s*:\s*"([a-f0-9]{16,40})"/i,/"publisher[_-]?id"\s*:\s*"([a-f0-9]{16,40})"/i,/\/id\/([a-f0-9]{16,40})/i];
  for(const re of patterns){const m=text.match(re);if(m?.[1])return m[1];}
  const u=String(url||'').match(/\/id\/([a-f0-9]{16,40})/i);return u?.[1]||'';
}

async function fetchDzenLauncherPosts(channelId, referer) {
  const endpoint=withParams('https://dzen.ru/api/v3/launcher/more',{channel_id:channelId});
  const res=await fetch(endpoint,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36','Accept':'application/json,text/plain,*/*','Accept-Language':'ru-RU,ru;q=0.9','Referer':referer||`https://dzen.ru/id/${channelId}`},redirect:'follow'});
  if(!res.ok)return [];
  const data=await res.json().catch(()=>null);if(!data)return [];
  const roots=Array.isArray(data?.items)?data.items:Array.isArray(data?.publications)?data.publications:[];
  const out=[];
  for(const item of roots){
    const text=cleanPublicText(firstNonEmpty(item.title,item.name,item.text,item.description,item.snippet,item.content?.title));
    const date=normalizePublicDate(firstNonEmpty(item.publish_time,item.publication_time,item.publicationTime,item.date,item.created_at,item.createdAt,item.time));
    const postUrl=absolutizePublicUrl(String(firstNonEmpty(item.link,item.url,item.canonical_url,item.canonicalUrl,item.publication_url)||''),'https://dzen.ru');
    const views=metricFromObject(item,['views','viewsCount','viewCount','statistics.views','stat.views','countViews']);
    const reactions=metricFromObject(item,['likes','likesCount','likeCount','statistics.likes','feedback_info.likes','countLikes']);
    const comments=metricFromObject(item,['comments','commentsCount','commentCount','statistics.comments','countComments']);
    if(!text||(!date&&!postUrl))continue;
    out.push({title:text.slice(0,180),date,reach:0,views,reactions,comments,shares:0,clicks:0,followers:0,followersDelta:0,postId:String(firstNonEmpty(item.id,item.publication_id,item.publicationId,postUrl)),postUrl,mediaType:/video/i.test(JSON.stringify(item).slice(0,4000))?'video':/image|photo|cover/i.test(JSON.stringify(item).slice(0,4000))?'image':'text',textLength:text.length});
  }
  return out.slice(0,120);
}

async function fetchPublicHtml(url, label) {
  const res = await fetch(url, { headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36', 'Accept-Language':'ru-RU,ru;q=0.9,en;q=0.6', Accept:'text/html,application/xhtml+xml' }, redirect:'follow' });
  const html = await res.text();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  if (!html || html.length < 300) throw new Error(`${label}: публичная страница вернула пустой ответ`);
  return { html, finalUrl: res.url };
}

async function replaceSocialPosts(env, channel, posts) {
  if (!Array.isArray(posts) || !posts.length) return; // временный блок/изменение HTML не стирает последнюю успешную историю
  await env.DB.prepare(`DELETE FROM social_posts WHERE channel=?`).bind(channel).run();
  await env.DB.prepare(`DELETE FROM social_channel_daily WHERE channel=?`).bind(channel).run();
  const daily = new Map();
  for (const post of posts.slice(0,150)) {
    if (!post?.date || !post?.title) continue;
    await env.DB.prepare(`INSERT INTO social_posts(channel,title,date,reach,views,reactions,comments,shares,clicks,followers,followers_delta,post_id,post_url,media_type,text_length,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(channel,title,date) DO UPDATE SET reach=excluded.reach,views=excluded.views,reactions=excluded.reactions,comments=excluded.comments,shares=excluded.shares,clicks=excluded.clicks,followers=excluded.followers,followers_delta=excluded.followers_delta,post_id=excluded.post_id,post_url=excluded.post_url,media_type=excluded.media_type,text_length=excluded.text_length,updated_at=CURRENT_TIMESTAMP`)
      .bind(channel,post.title,post.date,num(post.reach),num(post.views),num(post.reactions),num(post.comments),num(post.shares),num(post.clicks),num(post.followers),num(post.followersDelta),String(post.postId||''),String(post.postUrl||''),String(post.mediaType||'text'),num(post.textLength)).run();
    const d=daily.get(post.date)||{views:0,likes:0,comments:0,shares:0,reach:0};
    d.views+=num(post.views);d.likes+=num(post.reactions);d.comments+=num(post.comments);d.shares+=num(post.shares);d.reach+=num(post.reach);daily.set(post.date,d);
  }
  for (const [date,d] of daily) await env.DB.prepare(`INSERT INTO social_channel_daily(channel,date,views,visitors,reach,subscribers_reach,subscribed,unsubscribed,likes,comments,shares)
    VALUES(?,?,?,0,?,0,0,0,?,?,?) ON CONFLICT(channel,date) DO UPDATE SET views=excluded.views,reach=excluded.reach,likes=excluded.likes,comments=excluded.comments,shares=excluded.shares`)
    .bind(channel,date,d.views,d.reach,d.likes,d.comments,d.shares).run();
}

function parseStructuredPublicPosts(html, options={}) {
  const channel=options.channel||'Соцсеть', maxPosts=options.maxPosts||100, baseUrl=options.baseUrl||'';
  const objects=[];
  // JSON script blocks / hydration state are the most reliable public source on modern social pages.
  for (const m of String(html).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    let raw=String(m[1]||'').trim();
    if (!raw || raw.length<2 || raw.length>8_000_000) continue;
    raw=decodeHtml(raw);
    const candidates=[];
    if ((raw.startsWith('{')&&raw.endsWith('}'))||(raw.startsWith('[')&&raw.endsWith(']'))) candidates.push(raw);
    const assign=raw.match(/(?:__INITIAL_STATE__|__NEXT_DATA__|__PRELOADED_STATE__|initialState)\s*=\s*({[\s\S]+})\s*;?$/i);
    if (assign) candidates.push(assign[1]);
    for (const c of candidates) { try { objects.push(JSON.parse(c)); } catch {} }
  }
  const found=[];
  const seen=new Set();
  const visit=(node,depth=0)=>{
    if(depth>18||found.length>maxPosts*5||node==null)return;
    if(Array.isArray(node)){for(const x of node)visit(x,depth+1);return;}
    if(typeof node!=='object')return;
    const p=structuredObjectToPost(node,channel,baseUrl);
    if(p){const key=p.postId||p.postUrl||`${p.date}|${p.title}`;if(!seen.has(key)){seen.add(key);found.push(p);}}
    for(const v of Object.values(node)) if(v&&typeof v==='object')visit(v,depth+1);
  };
  objects.forEach(o=>visit(o));
  if (!found.length) found.push(...parsePublicHtmlFallback(html,channel,baseUrl));
  return found.filter(x=>x.date&&x.title).sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,maxPosts);
}

function structuredObjectToPost(o, channel, baseUrl) {
  const text=cleanPublicText(firstNonEmpty(o.text,o.title,o.name,o.description,o.caption,o.message?.text,o.body?.text,o.content?.text,o.publication?.title,o.publication?.text));
  const rawUrl=firstNonEmpty(o.url,o.link,o.href,o.permalink,o.webUrl,o.publicationUrl,o.shareUrl,o.canonicalUrl,o.postUrl);
  const id=firstNonEmpty(o.id,o.postId,o.publicationId,o.message_id,o.mid,o.uuid,o.slug);
  const rawDate=firstNonEmpty(o.publishTime,o.publicationTime,o.publishedAt,o.published_at,o.createdAt,o.created_at,o.createTime,o.date,o.timestamp,o.time);
  const date=normalizePublicDate(rawDate);
  const views=metricFromObject(o,['views','viewCount','viewsCount','view_count','impressions','stat.views','statistics.views','counters.views']);
  const reactions=metricFromObject(o,['likes','likesCount','likeCount','reactions','reactionsCount','stat.likes','counters.likes']);
  const comments=metricFromObject(o,['comments','commentsCount','commentCount','stat.comments','counters.comments']);
  const shares=metricFromObject(o,['shares','shareCount','reposts','repostsCount','stat.reposts','counters.reposts']);
  const hasSignal=Boolean(text && (date || rawUrl || id) && (views||reactions||comments||shares||rawUrl));
  if(!hasSignal)return null;
  const postUrl=absolutizePublicUrl(String(rawUrl||''),baseUrl);
  const mediaType=/video/i.test(JSON.stringify(o).slice(0,5000))?'video':/image|photo|cover/i.test(JSON.stringify(o).slice(0,5000))?'image':'text';
  return {title:(text||`${channel} ${id}`).slice(0,180),date,reach:0,views,reactions,comments,shares,clicks:0,followers:0,followersDelta:0,postId:String(id||postUrl||''),postUrl,mediaType,textLength:text.length};
}

function parsePublicHtmlFallback(html,channel,baseUrl){
  const out=[], text=decodeHtml(String(html||''));
  const timeHits=[...text.matchAll(/<time[^>]+datetime=["']([^"']+)["'][^>]*>/gi)];
  for(let i=0;i<timeHits.length&&out.length<100;i++){
    const h=timeHits[i],from=Math.max(0,h.index-5000),to=Math.min(text.length,h.index+18000),chunk=text.slice(from,to);
    const date=normalizePublicDate(h[1]); if(!date)continue;
    const title=cleanPublicText(firstMatch(chunk,/(?:aria-label|title)=["']([^"']{20,500})["']/i)||stripHtml(firstMatch(chunk,/<(?:h2|h3|article|p)[^>]*>([\s\S]{20,1200}?)<\/(?:h2|h3|article|p)>/i))).slice(0,180);
    if(!title)continue;
    const href=firstMatch(chunk,/href=["']([^"']+)["']/i);
    const views=parseCompactNumber(firstMatch(chunk,/(?:views?|просмотр(?:а|ов)?)[^\d]{0,30}([\d\s.,]+\s*[KMBКМ]?)/i)||firstMatch(chunk,/([\d\s.,]+\s*[KMBКМ]?)\s*(?:views?|просмотр(?:а|ов)?)/i));
    const reactions=parseCompactNumber(firstMatch(chunk,/(?:likes?|реакци[^\d]*)[^\d]{0,20}([\d\s.,]+\s*[KMBКМ]?)/i));
    out.push({title,date,reach:0,views,reactions,comments:0,shares:0,clicks:0,followers:0,followersDelta:0,postId:href||`${date}-${i}`,postUrl:absolutizePublicUrl(href,baseUrl),mediaType:/video/i.test(chunk)?'video':/img|photo|image/i.test(chunk)?'image':'text',textLength:title.length});
  }
  return out;
}

function firstNonEmpty(...xs){for(const x of xs){if(x!==undefined&&x!==null&&String(x).trim()!=='')return x;}return '';}
function cleanPublicText(v){return stripHtml(typeof v==='string'?v:typeof v==='object'?firstNonEmpty(v?.text,v?.title,v?.value):String(v||'')).replace(/\s+/g,' ').trim();}
function normalizePublicDate(v){if(v===undefined||v===null||v==='')return '';let d;if(typeof v==='number'||/^\d{10,13}$/.test(String(v))){let n=Number(v);if(n<1e12)n*=1000;d=new Date(n);}else d=new Date(String(v));return Number.isNaN(d.getTime())?'':dateOnly(d);}
function metricFromObject(o,paths){for(const p of paths){let v=o;for(const key of p.split('.'))v=v?.[key];if(typeof v==='object'&&v!==null)v=v.count??v.value??v.total;if(v!==undefined&&v!==null&&v!==''){const n=parseCompactNumber(v);if(n)return n;}}return 0;}
function absolutizePublicUrl(raw,base){if(!raw)return '';try{return new URL(raw,base||undefined).toString();}catch{return String(raw);}}

function firstMatch(text,re){const m=String(text||'').match(re);return m?m[1]||'':'';}
function parseCompactNumber(value){const s=stripHtml(String(value||'')).trim().replace(/\s/g,'').replace(',','.');const m=s.match(/([\d.]+)([KMBКММЛН]*)/i);if(!m)return num(s);let n=Number(m[1]||0),u=String(m[2]||'').toUpperCase();if(u==='K'||u==='К')n*=1e3;else if(u==='M'||u==='М'||u==='МЛН')n*=1e6;else if(u==='B')n*=1e9;return Math.round(n);}
function stripHtml(html){return decodeHtml(String(html||'').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,' '));}
function decodeHtml(s){return String(s||'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCharCode(parseInt(n,16)));}

/* -------------------- UNISENDER -------------------- */

async function syncUnisender(env) {
  if (!env.UNISENDER_API_KEY) throw new Error('Добавьте UNISENDER_API_KEY в Cloudflare Runtime Secrets.');
  const end = new Date(), start = new Date(); start.setDate(start.getDate() - 364);
  const from = `${dateOnly(start)} 00:00:00`, to = `${dateOnly(end)} 23:59:59`;
  const listUrl = withParams('https://api.unisender.com/ru/api/getCampaigns', { format:'json', api_key:env.UNISENDER_API_KEY, from, to, limit:200, offset:0 });
  const list = await apiGet(listUrl, {});
  if (list.error) throw new Error(`UniSender: ${list.error}`);
  const campaigns = Array.isArray(list.result) ? list.result : [];

  await env.DB.prepare('DELETE FROM email_campaigns').run();
  await env.DB.prepare('DELETE FROM email_links').run();
  let completed = 0;
  for (const group of chunks(campaigns.slice(0,200), 8)) {
    const stats = await Promise.all(group.map(async c => {
      const url = withParams('https://api.unisender.com/ru/api/getCampaignCommonStats', { format:'json', api_key:env.UNISENDER_API_KEY, campaign_id:c.id });
      const data = await apiGet(url, {}).catch(() => ({ result: {} }));
      return { c, s: data.result || {} };
    }));
    for (const { c, s } of stats) {
      const sent = num(s.sent), delivered = num(s.delivered), opened = num(s.read_unique), openedAll = num(s.read_all), clicked = num(s.clicked_unique), clickedAll = num(s.clicked_all), unsub = num(s.unsubscribed), spam = num(s.spam);
      const errors = Math.max(0, sent - delivered);
      await env.DB.prepare(`INSERT INTO email_campaigns(id,name,date,status,sent,delivered,opened,opened_all,clicked,clicked_all,unsub,spam,errors,report_url,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
        .bind(String(c.id),String(c.subject || `Рассылка ${c.id}`),String(c.start_time || '').slice(0,10),String(c.status || ''),sent,delivered,opened,openedAll,clicked,clickedAll,unsub,spam,errors,String(c.stats_url || '')).run();
      completed++;
    }
  }
  // Для последних рассылок сохраняем агрегированные клики по ссылкам. Ошибка этого дополнительного отчёта не ломает основную синхронизацию.
  for (const c of campaigns.slice(0, 30)) {
    const linkData = await apiGet(withParams('https://api.unisender.com/ru/api/getVisitedLinks', { format:'json', api_key:env.UNISENDER_API_KEY, campaign_id:c.id, group:1 }), {}).catch(() => null);
    const result = linkData?.result;
    if (!result || !Array.isArray(result.fields) || !Array.isArray(result.data)) continue;
    const urlIndex = result.fields.indexOf('url');
    const countIndex = result.fields.indexOf('count');
    if (urlIndex < 0) continue;
    for (const row of result.data) {
      const url = String(row?.[urlIndex] || '').trim(); if (!url) continue;
      const clicks = countIndex >= 0 ? num(row?.[countIndex]) : 1;
      await env.DB.prepare(`INSERT INTO email_links(campaign_id,url,clicks,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(campaign_id,url) DO UPDATE SET clicks=email_links.clicks+excluded.clicks,updated_at=CURRENT_TIMESTAMP`)
        .bind(String(c.id),url,clicks).run();
    }
  }

  await logSync(env,'unisender','ok',`UniSender: ${completed} рассылок`);
  return { message: `UniSender обновлён: ${completed} рассылок за последние 90 дней.` };
}


async function getAppSettings(env) {
  const rows = (await env.DB.prepare('SELECT setting_key,setting_value FROM app_settings').all().catch(()=>({results:[]}))).results || [];
  return Object.fromEntries(rows.map(x => [x.setting_key, x.setting_value]));
}
async function setAppSetting(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_settings(setting_key,setting_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP`).bind(String(key), value == null ? '' : String(value)).run();
}
async function appSettingsGet(env) {
  return json({ settings: await getAppSettings(env) });
}
async function appSettingsSave(request, env) {
  const body = await request.json().catch(()=>({}));
  const allowed = new Set(['primary_form_goal_id','primary_email_goal_id','ybusiness_counter_id','ybusiness_profile_url']);
  const changed = [];
  for (const [key,value] of Object.entries(body?.settings || body || {})) {
    if (!allowed.has(key)) continue;
    await setAppSetting(env,key,String(value || ''));
    changed.push(key);
  }
  return json({ ok:true, changed, settings:await getAppSettings(env) });
}


async function ybusinessCandidatesResponse(env) {
  if (!env.YANDEX_TOKEN) return json({ error:'Добавьте YANDEX_TOKEN' },400);
  const headers={Authorization:`OAuth ${env.YANDEX_TOKEN}`};
  const candidates=await listYandexBusinessCandidates(env,headers);
  const settings=await getAppSettings(env);
  return json({
    candidates,
    selectedCounterId:String(settings.ybusiness_counter_id||''),
    profileUrl:String(settings.ybusiness_profile_url||'https://yandex.ru/sprav/173574593150/')
  });
}

async function listYandexBusinessCandidates(env, headers) {
  const list=await apiGet(withParams('https://api-metrika.yandex.net/management/v1/counters',{per_page:1000}),headers);
  const counters=Array.isArray(list?.counters)?list.counters:[];
  const out=[];
  for (const batch of chunks(counters,8)) {
    const rows=await Promise.all(batch.map(async c=>{
      const data=await apiGet(`https://api-metrika.yandex.net/management/v1/counter/${encodeURIComponent(c.id)}/goals`,headers).catch(()=>null);
      const goals=(data?.goals||[]).filter(g=>g?.status!=='DELETED');
      const matched=goals.filter(g=>ybGoalKind(g));
      if(!matched.length) return null;
      const name=String(c.name||c.site||`Счётчик ${c.id}`);
      const site=String(c.site||'');
      const score=matched.length + (/бизнес|карты|организац|справочник/i.test(name)?4:0) + (normalizeHost(site)===normalizeHost(env.SITE_URL)?1:0);
      return {id:String(c.id),name,site,score,matchedGoals:matched.map(g=>({id:String(g.id),name:String(g.name||''),kind:ybGoalKind(g)}))};
    }));
    out.push(...rows.filter(Boolean));
  }
  return out.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name,'ru'));
}

/* -------------------- YANDEX BUSINESS / MAPS -------------------- */

const YB_GOAL_SIGNATURES = [
  { key:'calls', re:/клик\s+на\s+позвонить|нажат.*позвонить|позвонить/i },
  { key:'routes', re:/построить\s+маршрут|маршрут/i },
  { key:'cta', re:/призыв\s+к\s+действию|call\s*to\s*action|cta/i },
  { key:'subscribe', re:/подписк/i },
  { key:'like', re:/(^|\s)лайк|like/i },
  { key:'content', re:/просмотр\s+контента\s+компании|просмотр.*контент/i },
  { key:'website', re:/переход.*сайт|клик.*сайт|website/i }
];

function ybGoalKind(goal) {
  const name = String(goal?.name || '').trim();
  return YB_GOAL_SIGNATURES.find(x => x.re.test(name))?.key || '';
}

async function resolveYandexBusinessCounter(env, headers) {
  const settings=await getAppSettings(env);
  const selected=String(settings.ybusiness_counter_id||'').trim();
  const candidates=await listYandexBusinessCandidates(env,headers);
  const testCounter = async id => {
    const candidate=candidates.find(x=>String(x.id)===String(id));
    if(candidate){
      const data=await apiGet(`https://api-metrika.yandex.net/management/v1/counter/${encodeURIComponent(id)}/goals`,headers).catch(()=>null);
      return {...candidate,goals:(data?.goals||[]).filter(g=>g?.status!=='DELETED')};
    }
    return null;
  };
  if(selected){
    if(!String(settings.ybusiness_profile_url||'').trim()){
      throw new Error('Старая автоматическая привязка Яндекс Бизнеса отключена, чтобы не показывать данные чужого/другого профиля. Откройте «Яндекс Карты → Настроить профиль» и один раз выберите правильный счётчик для карточки 173574593150.');
    }
    const exact=await testCounter(selected);
    if(!exact) throw new Error(`Выбранный счётчик Яндекс Бизнеса ${selected} больше недоступен или не содержит целей профиля. Откройте «Яндекс Карты → Настроить профиль» и выберите нужный счётчик заново.`);
    await saveResolved(env,'ybusiness',exact.id,exact.name);
    return exact;
  }
  if(candidates.length===1){
    const exact=await testCounter(candidates[0].id);
    await setAppSetting(env,'ybusiness_counter_id',String(exact.id));
    await saveResolved(env,'ybusiness',exact.id,exact.name);
    return exact;
  }
  if(candidates.length>1){
    const preview=candidates.slice(0,6).map(x=>`${x.id}: ${x.name}`).join('; ');
    throw new Error(`Найдено несколько счётчиков Яндекс Бизнеса, поэтому приложение больше не выбирает профиль автоматически. Выберите правильный профиль в разделе «Яндекс Карты». Кандидаты: ${preview}`);
  }
  throw new Error('Не найден счётчик Яндекс Бизнеса в Метрике. Проверьте доступ этого Яндекс ID к профилю компании.');
}

async function syncYandexBusiness(env) {
  if (!env.YANDEX_TOKEN) throw new Error('Добавьте YANDEX_TOKEN в Cloudflare Runtime Secrets.');
  const headers = { Authorization:`OAuth ${env.YANDEX_TOKEN}` };
  const business = await resolveYandexBusinessCounter(env, headers);
  const counterId = business.id;
  const goals = (business.goals || []).filter(g=>g?.status!=='DELETED');
  const byKind = new Map();
  for (const g of goals) {
    const kind = ybGoalKind(g);
    if (kind && !byKind.has(kind)) byKind.set(kind,g);
  }
  const goalList = [...byKind.entries()];
  const metrics = ['ym:s:visits','ym:s:users', ...goalList.map(([,g])=>`ym:s:goal${g.id}reaches`)];
  const report = await apiGet(withParams('https://api-metrika.yandex.net/stat/v1/data', {
    ids:counterId,date1:'364daysAgo',date2:'today',accuracy:'full',lang:'ru',dimensions:'ym:s:date',metrics:metrics.join(','),limit:10000
  }), headers);
  await env.DB.prepare('DELETE FROM yandex_business_daily').run();
  let rows = 0;
  for (const row of report?.data || []) {
    const date = dimensionName(row.dimensions?.[0]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date||''))) continue;
    const m = row.metrics || [];
    const actions = { calls:0,routes:0,cta:0,subscribe:0,like:0,content:0,website:0 };
    goalList.forEach(([kind],i)=>{ actions[kind] = num(m[2+i]); });
    // Призыв к действию в автоматическом счётчике — отдельная системная цель. Не называем её "переходом на сайт", если Яндекс явно не создал цель с сайтом в названии.
    const targetActions = actions.calls + actions.routes + actions.cta + actions.subscribe + actions.like + actions.content + actions.website;
    await env.DB.prepare(`INSERT INTO yandex_business_daily(date,profile_views,target_clients,target_actions,routes,calls,website_clicks,direct_visits,discovery_visits,photo_views,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(date) DO UPDATE SET profile_views=excluded.profile_views,target_clients=excluded.target_clients,target_actions=excluded.target_actions,routes=excluded.routes,calls=excluded.calls,website_clicks=excluded.website_clicks,direct_visits=excluded.direct_visits,discovery_visits=excluded.discovery_visits,photo_views=excluded.photo_views,updated_at=CURRENT_TIMESTAMP`)
      .bind(date,num(m[0]),num(m[1]),targetActions,actions.routes,actions.calls,actions.website || actions.cta,0,0,actions.content).run();
    rows++;
  }

  // В публичном API Яндекс Бизнеса нет отдельного стабильного endpoint для всех таблиц профиля. Источники визитов можно получить из того же автоматического счётчика Метрики.
  const src = await apiGet(withParams('https://api-metrika.yandex.net/stat/v1/data', {
    ids:counterId,date1:'29daysAgo',date2:'today',accuracy:'full',lang:'ru',dimensions:'ym:s:trafficSourceName',metrics:'ym:s:visits',sort:'-ym:s:visits',limit:50
  }), headers).catch(()=>({data:[]}));
  await env.DB.prepare('DELETE FROM yandex_business_queries').run();
  for (const row of src?.data || []) {
    const name = dimensionName(row.dimensions?.[0]) || 'Источник не определён';
    const visits = num(row.metrics?.[0]);
    if (!visits) continue;
    await env.DB.prepare(`INSERT INTO yandex_business_queries(query,service,visits,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(query,service) DO UPDATE SET visits=excluded.visits,updated_at=CURRENT_TIMESTAMP`)
      .bind(name,'Источник визитов',visits).run();
  }
  const foundGoals = goalList.map(([kind,g])=>`${kind}:${g.name}`).join('; ');
  const status = rows ? 'ok' : 'partial';
  const message = rows
    ? `Яндекс Бизнес: найден автоматический счётчик «${business.name}» (${counterId}), загружено ${rows} дней. Системные цели: ${foundGoals || 'не распознаны'}. Данные могут обновляться в Метрике с задержкой.`
    : `Яндекс Бизнес: автоматический счётчик найден (${counterId}), но статистика за доступный период пуста.`;
  await logSync(env,'ybusiness',status,message);
  return { message, counterId, rows };
}

/* -------------------- YANDEX BUSINESS + WORKSPACE -------------------- */

async function workspaceData(env) {
  const rows = (await env.DB.prepare(`SELECT id,kind,parent_id AS parentId,status,title,body,priority,due_date AS dueDate,checked,pinned,sort_order AS sortOrder,created_at AS createdAt,updated_at AS updatedAt FROM workspace_items ORDER BY pinned DESC, sort_order, updated_at DESC`).all()).results || [];
  return json({ items: rows });
}

async function workspaceUpsert(request, env) {
  const body = await request.json();
  const item = body?.item || body || {};
  const kind = String(item.kind || '').trim();
  const title = String(item.title || '').trim().slice(0,240);
  if (!kind || !title) return json({ error: 'Для записи нужны kind и title' }, 400);
  const allowedKinds = new Set(['kanban','checklist','checkitem','note']);
  if (!allowedKinds.has(kind)) return json({ error: 'Неизвестный тип записи' }, 400);
  const id = String(item.id || `${kind}-${crypto.randomUUID()}`);
  const parentId = item.parentId ? String(item.parentId) : null;
  const status = String(item.status || (kind === 'kanban' ? 'backlog' : '')).slice(0,40);
  const bodyText = String(item.body || '').slice(0,20000);
  const priority = ['high','medium','low'].includes(String(item.priority)) ? String(item.priority) : 'medium';
  const dueDate = item.dueDate ? String(item.dueDate).slice(0,10) : null;
  const checked = item.checked ? 1 : 0;
  const pinned = item.pinned ? 1 : 0;
  const sortOrder = Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : 0;
  await env.DB.prepare(`INSERT INTO workspace_items(id,kind,parent_id,status,title,body,priority,due_date,checked,pinned,sort_order,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,parent_id=excluded.parent_id,status=excluded.status,title=excluded.title,body=excluded.body,priority=excluded.priority,due_date=excluded.due_date,checked=excluded.checked,pinned=excluded.pinned,sort_order=excluded.sort_order,updated_at=CURRENT_TIMESTAMP`)
    .bind(id,kind,parentId,status,title,bodyText,priority,dueDate,checked,pinned,sortOrder).run();
  return json({ ok: true, id });
}

async function workspaceDelete(url, env) {
  const id = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (!id) return json({ error: 'Не указан id' }, 400);
  await env.DB.prepare('DELETE FROM workspace_items WHERE id=? OR parent_id=?').bind(id,id).run();
  return json({ ok: true });
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
