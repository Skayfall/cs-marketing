const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const SESSION_COOKIE = 'cs_marketing_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12;

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

  if (request.method === 'GET' && url.pathname === '/api/status') return status(env);
  if (request.method === 'GET' && url.pathname === '/api/dashboard') return dashboard(env);
  if (request.method === 'POST' && url.pathname === '/api/import') return importRows(request, env);
  const m = url.pathname.match(/^\/api\/sync\/(metrika|webmaster|direct)$/);
  if (request.method === 'POST' && m) {
    const result = await syncSource(m[1], env);
    return json(result, 200);
  }
  return json({ error: 'Not found' }, 404);
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

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
  const cookie = `${SESSION_COOKIE}=${token}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
  return json({ authenticated: true, user: expectedUser }, 200, { 'set-cookie': cookie });
}

async function sessionStatus(request, env) {
  const session = await verifySession(request, env);
  if (!session) return json({ authenticated: false }, 401);
  return json({ authenticated: true, user: session.user });
}

function logout(url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return json({ authenticated: false }, 200, { 'set-cookie': `${SESSION_COOKIE}=; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=0` });
}

async function status(env) {
  const logs = await env.DB.prepare('SELECT source,last_sync,status,message FROM sync_log').all().catch(() => ({results:[]}));
  const map = Object.fromEntries((logs.results || []).map(x => [x.source, x]));
  const integrations = {
    metrika: { connected: Boolean(env.YANDEX_TOKEN && env.METRIKA_COUNTER_ID), lastSync: map.metrika?.last_sync || null },
    webmaster: { connected: Boolean(env.YANDEX_TOKEN && env.WEBMASTER_HOST_ID), lastSync: map.webmaster?.last_sync || null },
    direct: { connected: Boolean(env.DIRECT_TOKEN), lastSync: map.direct?.last_sync || null },
  };
  return json({ mode: Object.values(integrations).some(x => x.connected) ? 'live' : 'demo', integrations });
}

async function dashboard(env) {
  const [site,sources,pages,seo,ads,adsDaily] = await Promise.all([
    env.DB.prepare('SELECT date,visits,users,pageviews,bounce_rate AS bounceRate,depth,duration,conversions FROM daily_site_metrics ORDER BY date').all(),
    env.DB.prepare('SELECT name,visits,conversions FROM traffic_sources WHERE period_key=(SELECT MAX(period_key) FROM traffic_sources) ORDER BY visits DESC').all(),
    env.DB.prepare('SELECT page,title,visits,bounce,depth,conversions FROM landing_pages WHERE period_key=(SELECT MAX(period_key) FROM landing_pages) ORDER BY visits DESC LIMIT 100').all(),
    env.DB.prepare('SELECT query,shows,clicks,ctr,position,delta FROM seo_queries ORDER BY shows DESC LIMIT 500').all(),
    env.DB.prepare('SELECT name,impressions,clicks,spend,conversions FROM ad_campaigns ORDER BY spend DESC').all(),
    env.DB.prepare('SELECT date,spend,clicks,conversions FROM ad_daily ORDER BY date').all()
  ]);
  return json({ site:site.results||[], sources:sources.results||[], pages:pages.results||[], seo:seo.results||[], ads:ads.results||[], adsDaily:adsDaily.results||[] });
}

async function syncConfigured(env) {
  const jobs=[];
  if(env.YANDEX_TOKEN && env.METRIKA_COUNTER_ID) jobs.push(syncMetrika(env));
  if(env.YANDEX_TOKEN && env.WEBMASTER_HOST_ID) jobs.push(syncWebmaster(env));
  if(env.DIRECT_TOKEN) jobs.push(syncDirect(env));
  await Promise.allSettled(jobs);
}

async function syncSource(source, env) {
  if(source==='metrika') return syncMetrika(env);
  if(source==='webmaster') return syncWebmaster(env);
  if(source==='direct') return syncDirect(env);
  throw new Error('Unknown source');
}

async function syncMetrika(env) {
  if(!env.YANDEX_TOKEN || !env.METRIKA_COUNTER_ID) throw new Error('Добавьте YANDEX_TOKEN и METRIKA_COUNTER_ID в secrets.');
  const headers = { Authorization: `OAuth ${env.YANDEX_TOKEN}` };
  const base='https://api-metrika.yandex.net/stat/v1/data';
  const common={ids:env.METRIKA_COUNTER_ID,date1:'89daysAgo',date2:'today',accuracy:'full'};
  const dailyUrl=withParams(base,{...common,dimensions:'ym:s:date',metrics:'ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds'});
  const sourceUrl=withParams(base,{...common,date1:'29daysAgo',dimensions:'ym:s:trafficSourceName',metrics:'ym:s:visits,ym:s:users',sort:'-ym:s:visits',limit:'50'});
  const pageUrl=withParams(base,{...common,date1:'29daysAgo',dimensions:'ym:s:startURL',metrics:'ym:s:visits,ym:s:bounceRate,ym:s:pageDepth',sort:'-ym:s:visits',limit:'100'});
  const [dailyRes,sourceRes,pageRes]=await Promise.all([apiGet(dailyUrl,headers),apiGet(sourceUrl,headers),apiGet(pageUrl,headers)]);
  for(const row of dailyRes.data||[]){
    const date=row.dimensions?.[0]?.name||row.dimensions?.[0]?.id; const m=row.metrics||[]; if(!date)continue;
    await env.DB.prepare(`INSERT INTO daily_site_metrics(date,visits,users,pageviews,bounce_rate,depth,duration,conversions,updated_at) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(date) DO UPDATE SET visits=excluded.visits,users=excluded.users,pageviews=excluded.pageviews,bounce_rate=excluded.bounce_rate,depth=excluded.depth,duration=excluded.duration,updated_at=CURRENT_TIMESTAMP`)
      .bind(date,num(m[0]),num(m[1]),num(m[2]),num(m[3]),num(m[4]),num(m[5]),0).run();
  }
  const periodKey=new Date().toISOString().slice(0,10);
  await env.DB.prepare('DELETE FROM traffic_sources WHERE period_key=?').bind(periodKey).run();
  for(const row of sourceRes.data||[]){const name=row.dimensions?.[0]?.name||'Прочее';await env.DB.prepare('INSERT INTO traffic_sources(period_key,name,visits,conversions) VALUES(?,?,?,0)').bind(periodKey,name,num(row.metrics?.[0])).run();}
  await env.DB.prepare('DELETE FROM landing_pages WHERE period_key=?').bind(periodKey).run();
  for(const row of pageRes.data||[]){const page=row.dimensions?.[0]?.name||row.dimensions?.[0]?.id||'';if(!page)continue;await env.DB.prepare('INSERT INTO landing_pages(period_key,page,title,visits,bounce,depth,conversions) VALUES(?,?,?,?,?,?,0)').bind(periodKey,page,page,num(row.metrics?.[0]),num(row.metrics?.[1]),num(row.metrics?.[2])).run();}
  await logSync(env,'metrika','ok',`Получено ${dailyRes.data?.length||0} дневных строк`);
  return { message:`Метрика обновлена: ${dailyRes.data?.length||0} дней.` };
}

async function syncWebmaster(env) {
  if(!env.YANDEX_TOKEN || !env.WEBMASTER_HOST_ID) throw new Error('Добавьте YANDEX_TOKEN и WEBMASTER_HOST_ID в secrets.');
  const headers={Authorization:`OAuth ${env.YANDEX_TOKEN}`};
  const user=await apiGet('https://api.webmaster.yandex.net/v4/user',headers); const uid=user.user_id||user.userId;
  if(!uid) throw new Error('Вебмастер не вернул user_id. Проверьте OAuth-доступ.');
  const host=encodeURIComponent(env.WEBMASTER_HOST_ID);
  const end=new Date(); const start=new Date(); start.setDate(start.getDate()-29); const prevStart=new Date();prevStart.setDate(prevStart.getDate()-59);const prevEnd=new Date();prevEnd.setDate(prevEnd.getDate()-30);
  const params={order_by:'TOTAL_SHOWS',query_indicator:['TOTAL_SHOWS','TOTAL_CLICKS','AVG_SHOW_POSITION'],date_from:dateOnly(start),date_to:dateOnly(end),limit:'500'};
  const current=await apiGet(withParams(`https://api.webmaster.yandex.net/v4/user/${uid}/hosts/${host}/search-queries/popular`,params),headers);
  const prev=await apiGet(withParams(`https://api.webmaster.yandex.net/v4/user/${uid}/hosts/${host}/search-queries/popular`,{...params,date_from:dateOnly(prevStart),date_to:dateOnly(prevEnd)}),headers).catch(()=>({queries:[]}));
  const prevByText=new Map((prev.queries||[]).map(q=>[q.query_text,q]));
  for(const q of current.queries||[]){
    const ind=q.indicators||{}; const shows=num(ind.TOTAL_SHOWS), clicks=num(ind.TOTAL_CLICKS), position=num(ind.AVG_SHOW_POSITION); const prevQ=prevByText.get(q.query_text); const prevPos=num(prevQ?.indicators?.AVG_SHOW_POSITION); const delta=prevPos&&position?prevPos-position:0; const ctr=shows?clicks/shows*100:0;
    await env.DB.prepare(`INSERT INTO seo_queries(query,shows,clicks,ctr,position,delta,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(query) DO UPDATE SET shows=excluded.shows,clicks=excluded.clicks,ctr=excluded.ctr,position=excluded.position,delta=excluded.delta,updated_at=CURRENT_TIMESTAMP`)
      .bind(q.query_text,shows,clicks,ctr,position,delta).run();
  }
  await logSync(env,'webmaster','ok',`Получено ${current.queries?.length||0} запросов`);
  return { message:`Вебмастер обновлён: ${current.queries?.length||0} запросов.` };
}

async function syncDirect(env) {
  if(!env.DIRECT_TOKEN) throw new Error('Добавьте DIRECT_TOKEN в secrets. Для API Директа также нужен одобренный доступ приложения.');
  const end=new Date(), start=new Date();start.setDate(start.getDate()-29);
  const body={params:{SelectionCriteria:{DateFrom:dateOnly(start),DateTo:dateOnly(end)},FieldNames:['Date','CampaignName','Impressions','Clicks','Cost','Conversions'],ReportName:`CS Marketing ${Date.now()}`,ReportType:'CAMPAIGN_PERFORMANCE_REPORT',DateRangeType:'CUSTOM_DATE',Format:'TSV',IncludeVAT:'YES',IncludeDiscount:'YES'}};
  const headers={'Authorization':`Bearer ${env.DIRECT_TOKEN}`,'Accept-Language':'ru','returnMoneyInMicros':'false','Content-Type':'application/json'}; if(env.DIRECT_CLIENT_LOGIN)headers['Client-Login']=env.DIRECT_CLIENT_LOGIN;
  let res=await fetch('https://api.direct.yandex.com/json/v501/reports',{method:'POST',headers,body:JSON.stringify(body)});
  if(res.status===201||res.status===202){await logSync(env,'direct','pending','Отчёт формируется');return {message:'Директ принял отчёт на формирование. Нажмите обновить позже.'};}
  if(!res.ok)throw new Error(`Direct API ${res.status}: ${(await res.text()).slice(0,400)}`);
  const text=await res.text(); const rows=parseDirectTsv(text); const campaignMap=new Map(), dayMap=new Map();
  for(const r of rows){const day=r.Date,name=r.CampaignName||'Кампания',impressions=num(r.Impressions),clicks=num(r.Clicks),spend=num(r.Cost),conversions=num(r.Conversions);const c=campaignMap.get(name)||{name,impressions:0,clicks:0,spend:0,conversions:0};c.impressions+=impressions;c.clicks+=clicks;c.spend+=spend;c.conversions+=conversions;campaignMap.set(name,c);const d=dayMap.get(day)||{date:day,spend:0,clicks:0,conversions:0};d.spend+=spend;d.clicks+=clicks;d.conversions+=conversions;dayMap.set(day,d);}
  for(const c of campaignMap.values())await env.DB.prepare(`INSERT INTO ad_campaigns(name,impressions,clicks,spend,conversions,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(name) DO UPDATE SET impressions=excluded.impressions,clicks=excluded.clicks,spend=excluded.spend,conversions=excluded.conversions,updated_at=CURRENT_TIMESTAMP`).bind(c.name,c.impressions,c.clicks,c.spend,c.conversions).run();
  for(const d of dayMap.values())await env.DB.prepare(`INSERT INTO ad_daily(date,spend,clicks,conversions,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(date) DO UPDATE SET spend=excluded.spend,clicks=excluded.clicks,conversions=excluded.conversions,updated_at=CURRENT_TIMESTAMP`).bind(d.date,d.spend,d.clicks,d.conversions).run();
  await logSync(env,'direct','ok',`Получено ${rows.length} строк`); return {message:`Директ обновлён: ${campaignMap.size} кампаний.`};
}

async function importRows(request, env){
  const {source,rows,mode}=await request.json(); if(!Array.isArray(rows))return json({error:'rows must be array'},400);
  if(source==='seo'){if(mode==='replace')await env.DB.prepare('DELETE FROM seo_queries').run();for(const x of rows.slice(0,5000))await env.DB.prepare(`INSERT INTO seo_queries(query,shows,clicks,ctr,position,delta,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(query) DO UPDATE SET shows=excluded.shows,clicks=excluded.clicks,ctr=excluded.ctr,position=excluded.position,delta=excluded.delta,updated_at=CURRENT_TIMESTAMP`).bind(x.query,num(x.shows),num(x.clicks),num(x.ctr),num(x.position),num(x.delta)).run();}
  if(source==='ads'){if(mode==='replace')await env.DB.prepare('DELETE FROM ad_campaigns').run();for(const x of rows.slice(0,5000))await env.DB.prepare(`INSERT INTO ad_campaigns(name,impressions,clicks,spend,conversions,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(name) DO UPDATE SET impressions=excluded.impressions,clicks=excluded.clicks,spend=excluded.spend,conversions=excluded.conversions,updated_at=CURRENT_TIMESTAMP`).bind(x.name,num(x.impressions),num(x.clicks),num(x.spend),num(x.conversions)).run();}
  if(source==='site'){if(mode==='replace')await env.DB.prepare('DELETE FROM daily_site_metrics').run();for(const x of rows.slice(0,5000))await env.DB.prepare(`INSERT INTO daily_site_metrics(date,visits,users,pageviews,bounce_rate,depth,duration,conversions,updated_at) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(date) DO UPDATE SET visits=excluded.visits,users=excluded.users,pageviews=excluded.pageviews,bounce_rate=excluded.bounce_rate,depth=excluded.depth,duration=excluded.duration,conversions=excluded.conversions,updated_at=CURRENT_TIMESTAMP`).bind(x.date,num(x.visits),num(x.users),num(x.pageviews),num(x.bounceRate),num(x.depth),num(x.duration),num(x.conversions)).run();}
  return json({ok:true,imported:rows.length});
}

async function verifySession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const token = readCookie(request.headers.get('cookie') || '', SESSION_COOKIE);
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload64, signature64] = parts;
  const valid = await verifySignature(payload64, signature64, env.SESSION_SECRET);
  if (!valid) return null;
  let payload;
  try { payload = JSON.parse(decodeBase64Url(payload64)); } catch { return null; }
  if (!payload?.user || !payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  const expectedUser = String(env.ADMIN_USERNAME || 'admin');
  if (!(await secureTextEqual(String(payload.user), expectedUser))) return null;
  return payload;
}

async function createSessionToken(user, exp, secret) {
  const payload64 = encodeBase64Url(JSON.stringify({ user, exp }));
  const signature64 = await sign(payload64, secret);
  return `${payload64}.${signature64}`;
}

async function sign(payload, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifySignature(payload, signature64, secret) {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, base64UrlToBytes(signature64), encoder.encode(payload));
  } catch { return false; }
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

function encodeBase64Url(text) { return bytesToBase64Url(new TextEncoder().encode(text)); }
function decodeBase64Url(value) { return new TextDecoder().decode(base64UrlToBytes(value)); }
function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function withParams(url,params){const u=new URL(url);for(const [k,v] of Object.entries(params)){if(v===undefined||v===null||v==='')continue;if(Array.isArray(v))v.forEach(x=>u.searchParams.append(k,x));else u.searchParams.set(k,v);}return u.toString();}
async function apiGet(url,headers){const r=await fetch(url,{headers});if(!r.ok)throw new Error(`${r.status} ${await r.text()}`);return r.json();}
function num(v){const x=Number(String(v??0).replace(',','.'));return Number.isFinite(x)?x:0;}
function dateOnly(d){return d.toISOString().slice(0,10);}
function parseDirectTsv(text){const lines=text.split(/\r?\n/).filter(Boolean);const headerIndex=lines.findIndex(x=>x.startsWith('Date\t'));if(headerIndex<0)return[];const headers=lines[headerIndex].split('\t');return lines.slice(headerIndex+1).filter(x=>!x.startsWith('Total rows:')).map(line=>{const vals=line.split('\t');return Object.fromEntries(headers.map((h,i)=>[h,vals[i]]));});}
async function logSync(env,source,status,message){await env.DB.prepare(`INSERT INTO sync_log(source,last_sync,status,message) VALUES(?,datetime('now'),?,?) ON CONFLICT(source) DO UPDATE SET last_sync=datetime('now'),status=excluded.status,message=excluded.message`).bind(source,status,message).run();}
