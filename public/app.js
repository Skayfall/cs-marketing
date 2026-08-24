(() => {
  'use strict';

  const fmt = new Intl.NumberFormat('ru-RU');
  const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
  const pct = (v, d = 1) => v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `${Number(v).toFixed(d).replace('.', ',')}%`;
  const num = (v) => Number(v || 0);
  const sum = (arr, key) => (arr || []).reduce((a, x) => a + num(typeof key === 'function' ? key(x) : x?.[key]), 0);
  const avg = (arr, key) => (arr || []).length ? sum(arr, key) / arr.length : 0;
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const today = new Date();
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const ruDate = (s) => s ? new Date(`${String(s).slice(0,10)}T12:00:00`).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' }) : '—';
  const duration = (seconds) => {
    const s = Math.max(0, Math.round(num(seconds))); const m = Math.floor(s / 60); const r = s % 60;
    return `${m}:${String(r).padStart(2,'0')}`;
  };
  const valueOrDash = (v, formatter = (x) => fmt.format(x)) => (v === null || v === undefined) ? '—' : formatter(v);
  const dayStart = (days) => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - (days - 1)); return d; };
  const inPeriod = (date, days) => { if (!date) return false; const d = new Date(`${String(date).slice(0,10)}T12:00:00`); return d >= dayStart(days); };

  const blank = () => ({
    site: [], sitePeriods: {}, sources: [], pages: [], searchEngines: [], devices: [], regions: [], goals: [],
    seo: [], seoSummary: null, seoIndex: [], seoProblems: [],
    adsMeta: [], adsDaily: [], social: [], email: [],
    meta: { metrikaCounterId: null, goalMapping: { email: [], forms: [] } }
  });

  let state = blank();
  let apiStatus = { mode: 'empty', integrations: {} };
  let charts = {};
  let currentUser = null;
  let adChannelFilter = 'Все';

  const LOCAL_KEY = 'cs-marketing-v6-local';
  const AUTH_TOKEN_KEY = 'cs-marketing-auth-token-v4';
  const local = loadLocal();

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch { return {}; }
  }
  function saveLocal() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ manualTasks: local.manualTasks || [], doneTasks: local.doneTasks || {} })); } catch {}
  }
  function getFallbackToken() { try { return sessionStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch { return ''; } }
  function setFallbackToken(token) { try { token ? sessionStorage.setItem(AUTH_TOKEN_KEY, token) : sessionStorage.removeItem(AUTH_TOKEN_KEY); } catch {} }
  async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {}); const token = getFallbackToken();
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return fetch(url, { ...options, headers, credentials: 'include', cache: 'no-store' });
  }

  function showAuthScreen(message = '') {
    currentUser = null; document.getElementById('appShell').hidden = true; document.getElementById('authScreen').hidden = false;
    const err = document.getElementById('authError'); err.textContent = message; err.hidden = !message;
    document.getElementById('passwordInput').value = '';
  }
  async function showApp(user) {
    currentUser = user || 'admin'; document.getElementById('authScreen').hidden = true; document.getElementById('appShell').hidden = false;
    document.getElementById('accountName').textContent = currentUser;
    renderAll(); await fetchApiStatus(); await loadLiveData();
  }
  async function checkSession(token = getFallbackToken()) {
    const headers = new Headers({ Accept: 'application/json' }); if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch('/api/auth/session', { headers, credentials: 'include', cache: 'no-store' });
    const data = await response.json().catch(() => ({})); return { response, data };
  }
  async function initAuth() {
    try { const { response, data } = await checkSession(); if (response.ok && data.authenticated) return showApp(data.user); setFallbackToken(''); showAuthScreen(); }
    catch (e) { showAuthScreen(`Не удалось связаться с сервером: ${e?.message || 'ошибка сети'}`); }
  }
  async function login(event) {
    event.preventDefault(); const button = document.getElementById('loginBtn'); const error = document.getElementById('authError'); error.hidden = true;
    button.disabled = true; button.textContent = 'Проверяю…';
    try {
      const response = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json',Accept:'application/json'}, credentials:'include', cache:'no-store', body:JSON.stringify({username:document.getElementById('loginInput').value.trim(),password:document.getElementById('passwordInput').value}) });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `Ошибка входа (${response.status})`);
      if (data.token) setFallbackToken(data.token); await showApp(data.user || 'admin');
    } catch (e) { error.textContent = e?.message || 'Не удалось войти'; error.hidden = false; }
    finally { button.disabled = false; button.textContent = 'Войти'; }
  }
  async function logout() { try { await apiFetch('/api/auth/logout', { method:'POST' }); } catch {} setFallbackToken(''); showAuthScreen(); }

  function renderMetricGrid(id, items) {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = items.map(x => `<article class="metric-card"><div class="metric-top"><div class="metric-title">${escapeHtml(x.title)}</div>${x.delta === null || x.delta === undefined ? '' : `<span class="delta ${x.delta>0?'up':x.delta<0?'down':'flat'}">${x.delta>0?'+':''}${Number(x.delta).toFixed(1).replace('.',',')}%</span>`}</div><div class="metric-value">${x.value}</div><div class="metric-note">${escapeHtml(x.note || '')}</div></article>`).join('');
  }
  function statusPill(text, cls='info') { return `<span class="status ${cls}">${escapeHtml(text)}</span>`; }
  function issueHtml(x) { return `<div class="issue-item"><div class="issue-icon ${x.level}">${x.level==='high'?'!':x.level==='medium'?'↗':'i'}</div><div><div class="issue-title">${escapeHtml(x.title)}</div><div class="issue-text">${escapeHtml(x.text)}</div>${x.action?`<div class="issue-action">${escapeHtml(x.action)}</div>`:''}</div></div>`; }
  function chart(id, type, data, options = {}) {
    const canvas = document.getElementById(id); if (!canvas || !window.Chart) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(canvas, { type, data, options:{ responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false}, plugins:{legend:{display:false},tooltip:{enabled:true}}, scales:type==='doughnut'?{}:{x:{grid:{display:false},ticks:{color:'#98a2b3'}},y:{beginAtZero:true,grid:{color:'#eef0f3'},ticks:{color:'#98a2b3'}}}, ...options } });
  }
  function compareSeries(arr, days, key) {
    const sorted = [...(arr||[])].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    const current = sorted.filter(x=>inPeriod(x.date,days)); const prevStart = new Date(dayStart(days)); prevStart.setDate(prevStart.getDate()-days); const prevEnd = new Date(dayStart(days)); prevEnd.setDate(prevEnd.getDate()-1);
    const previous = sorted.filter(x=>{const d=new Date(`${x.date}T12:00:00`);return d>=prevStart&&d<=prevEnd;});
    const c=sum(current,key), p=sum(previous,key); return { current:c, previous:p, delta:p?((c-p)/p*100):null };
  }

  function siteRows(days) { return state.site.filter(x=>inPeriod(x.date,days)).sort((a,b)=>String(a.date).localeCompare(String(b.date))); }
  function siteSummary(days) {
    const exact=state.sitePeriods?.[String(days)] || state.sitePeriods?.[days];
    if(exact) return {visits:num(exact.visits),users:num(exact.users),pageviews:num(exact.pageviews),bounce:num(exact.bounceRate),depth:num(exact.depth),duration:num(exact.duration),newVisitors:num(exact.newVisitors),goals:num(exact.conversions),emailClicks:num(exact.emailClicks),formSubmits:num(exact.formSubmits)};
    const rows=siteRows(days); if(!rows.length)return null;
    return {visits:sum(rows,'visits'),users:sum(rows,'users'),pageviews:sum(rows,'pageviews'),bounce:avg(rows,'bounceRate'),depth:avg(rows,'depth'),duration:avg(rows,'duration'),newVisitors:avg(rows,'newVisitors'),goals:sum(rows,'conversions'),emailClicks:sum(rows,'emailClicks'),formSubmits:sum(rows,'formSubmits')};
  }
  function seoSummary() {
    if(!state.seo.length && !state.seoSummary)return null;
    return {shows:sum(state.seo,'shows'),clicks:sum(state.seo,'clicks'),ctr:sum(state.seo,'shows')?sum(state.seo,'clicks')/sum(state.seo,'shows')*100:0,position:avg(state.seo,'position'),...(state.seoSummary||{})};
  }
  function aggregateAds(days, channel='Все') {
    const rows=(state.adsDaily||[]).filter(x=>inPeriod(x.date,days) && (channel==='Все'||x.channel===channel));
    const meta=(state.adsMeta||[]).filter(x=>channel==='Все'||x.channel===channel);
    const map=new Map();
    meta.forEach(m=>map.set(`${m.channel}|${m.campaignId||m.name}`,{...m,impressions:0,clicks:0,spend:0,conversions:0}));
    rows.forEach(r=>{const key=`${r.channel}|${r.campaignId||r.name}`;const v=map.get(key)||{channel:r.channel,name:r.name,campaignId:r.campaignId||'',status:r.status||'unknown',impressions:0,clicks:0,spend:0,conversions:0};v.impressions+=num(r.impressions);v.clicks+=num(r.clicks);v.spend+=num(r.spend);v.conversions+=num(r.conversions);map.set(key,v);});
    return [...map.values()].map(x=>({...x,ctr:x.impressions?x.clicks/x.impressions*100:0,cpc:x.clicks?x.spend/x.clicks:0,cvr:x.clicks?x.conversions/x.clicks*100:0,cpa:x.conversions?x.spend/x.conversions:null}));
  }
  function adTotals(rows){return {impressions:sum(rows,'impressions'),clicks:sum(rows,'clicks'),spend:sum(rows,'spend'),conversions:sum(rows,'conversions')};}
  function socialRows(days){return state.social.filter(x=>!x.date||inPeriod(x.date,days));}
  function socialSummary(days){const rows=socialRows(days);if(!rows.length)return null;const eng=sum(rows,x=>num(x.reactions)+num(x.comments)+num(x.shares));const latestByChannel=new Map();[...rows].sort((a,b)=>String(a.date).localeCompare(String(b.date))).forEach(x=>{if(x.followers!==null&&x.followers!==undefined)latestByChannel.set(x.channel,x);});return {posts:rows.length,reach:sum(rows,'reach'),views:sum(rows,'views'),engagements:eng,clicks:sum(rows,'clicks'),er:sum(rows,'reach')?eng/sum(rows,'reach')*100:0,followers:[...latestByChannel.values()].reduce((a,x)=>a+num(x.followers),0),followersDelta:[...latestByChannel.values()].reduce((a,x)=>a+num(x.followersDelta),0)};}
  function emailRows(days){return state.email.filter(x=>!x.date||inPeriod(x.date,days));}
  function emailSummary(days){const rows=emailRows(days);if(!rows.length)return null;const sent=sum(rows,'sent'),delivered=sum(rows,'delivered'),opened=sum(rows,'opened'),clicked=sum(rows,'clicked');return {sent,delivered,opened,clicked,errors:sum(rows,'errors'),unsub:sum(rows,'unsub'),spam:sum(rows,'spam'),deliveryRate:sent?delivered/sent*100:0,openRate:delivered?opened/delivered*100:0,ctr:delivered?clicked/delivered*100:0,unsubRate:delivered?sum(rows,'unsub')/delivered*100:0};}

  function getOverviewIssues(days) {
    const out=[]; const s=siteSummary(days); const seo=seoSummary();
    if(!s) out.push({level:'medium',title:'Нет данных Метрики',text:'Пока нельзя оценить посещаемость и заявки.',action:'Подключить Яндекс Метрику или импортировать отчёт.'});
    else {
      if(s.bounce>35) out.push({level:'high',title:'Высокий показатель отказов',text:`Среднее значение ${pct(s.bounce)} за выбранный период.`,action:'Проверить страницы входа и несколько сессий в Вебвизоре.'});
      if(s.formSubmits===0 && (state.meta?.goalMapping?.forms||[]).length) out.push({level:'high',title:'Нет отправок форм',text:'Цели форм найдены, но за период нет достижений.',action:'Проверить формы на сайте и корректность срабатывания целей.'});
      if(!(state.meta?.goalMapping?.forms||[]).length) out.push({level:'medium',title:'Цель отправки заявки не определена',text:'Приложение не нашло подходящую цель формы в Метрике.',action:'Проверить названия целей или создать отдельную цель «Отправка формы».'});
    }
    const falling=[...state.seo].filter(x=>num(x.delta)<-1&&num(x.shows)>100).sort((a,b)=>a.delta-b.delta)[0];
    if(falling) out.push({level:'medium',title:`Проседает запрос «${falling.query}»`,text:`Позиция ${num(falling.position).toFixed(1)}, изменение ${num(falling.delta).toFixed(1)}.`,action:'Открыть SEO → проверить страницу и сниппет.'});
    if(seo && num(seo.critical)>0) out.push({level:'high',title:'В Вебмастере есть критические проблемы',text:`Критических проблем: ${fmt.format(seo.critical)}.`,action:'Открыть SEO → Диагностика и исправить сначала критические ошибки.'});
    return out.slice(0,6);
  }

  function renderOverview(){
    const days=num(document.getElementById('periodSelect').value||30), s=siteSummary(days), visitsCmp=compareSeries(state.site,days,'visits');
    renderMetricGrid('overviewMetrics',[
      {title:'Посещения сайта',value:s?fmt.format(s.visits):'—',delta:s?visitsCmp.delta:null,note:`за ${days} дней`},
      {title:'Посетители',value:s?fmt.format(s.users):'—',note:'уникальные пользователи'},
      {title:'Клики по email',value:s?fmt.format(s.emailClicks):'—',note:(state.meta?.goalMapping?.email||[]).length?`цели: ${state.meta.goalMapping.email.join(', ')}`:'цель пока не найдена'},
      {title:'Отправки заявок',value:s?fmt.format(s.formSubmits):'—',note:(state.meta?.goalMapping?.forms||[]).length?`цели: ${state.meta.goalMapping.forms.join(', ')}`:'цель пока не найдена'}
    ]);
    const rows=siteRows(days); chart('overviewChart','line',{labels:rows.map(x=>ruDate(x.date)),datasets:[{label:'Визиты',data:rows.map(x=>x.visits),borderColor:'#4457ff',backgroundColor:'rgba(68,87,255,.08)',fill:true,tension:.28,pointRadius:0},{label:'Заявки',data:rows.map(x=>x.formSubmits||0),borderColor:'#12b76a',backgroundColor:'transparent',tension:.28,pointRadius:2}]},{plugins:{legend:{display:true,position:'bottom'}}});
    const connected=Boolean(apiStatus.integrations?.metrika?.connected), counter=state.meta?.metrikaCounterId || apiStatus.metrikaCounterId;
    const btn=document.getElementById('openWebvisorBtn'); btn.disabled=!connected||!counter; btn.onclick=()=>{if(counter)window.open(`https://metrika.yandex.ru/webvisor?id=${encodeURIComponent(counter)}`,'_blank','noopener');};
    const ws=document.getElementById('webvisorStatus'); ws.textContent=connected?'Метрика подключена':'Нет подключения'; ws.className=`badge ${connected?'good':'warn'}`;
    document.getElementById('webvisorHints').innerHTML=s?`<div class="mini-stat"><strong>${pct(s.bounce)}</strong><span>отказы</span></div><div class="mini-stat"><strong>${duration(s.duration)}</strong><span>среднее время</span></div><div class="mini-stat"><strong>${s.depth.toFixed(2)}</strong><span>глубина</span></div>`:'';
    const src=state.sources.slice(0,8); chart('sourceChart','doughnut',{labels:src.map(x=>x.name),datasets:[{data:src.map(x=>x.visits),backgroundColor:['#4457ff','#12b76a','#f79009','#2e90fa','#7f56d9','#98a2b3','#e31b54','#6172f3']}]},{plugins:{legend:{display:true,position:'bottom'}}});
    const engines=state.searchEngines.slice(0,8), max=Math.max(1,...engines.map(x=>num(x.visits))); document.getElementById('searchEngineList').innerHTML=engines.length?engines.map(x=>`<div class="rank-row"><div><strong>${escapeHtml(x.name)}</strong><span>${fmt.format(x.visits)} визитов</span></div><div class="rank-bar"><i style="width:${Math.max(3,num(x.visits)/max*100)}%"></i></div></div>`).join(''):`<div class="empty-state">Нет данных по поисковым системам.</div>`;
    const issues=getOverviewIssues(days); document.getElementById('issuesCount').textContent=`${issues.length} ${issues.length===1?'сигнал':'сигналов'}`; document.getElementById('issueList').innerHTML=issues.length?issues.map(issueHtml).join(''):`<div class="empty-state">Критичных сигналов по доступным данным нет.</div>`;
  }

  function renderSite(){
    const days=num(document.getElementById('periodSelect').value||30), s=siteSummary(days), rows=siteRows(days);
    renderMetricGrid('siteMetrics',[
      {title:'Визиты',value:s?fmt.format(s.visits):'—',note:'сессии'}, {title:'Пользователи',value:s?fmt.format(s.users):'—',note:'уникальные посетители'}, {title:'Просмотры',value:s?fmt.format(s.pageviews):'—',note:'страницы'}, {title:'Отказы',value:s?pct(s.bounce):'—',note:'среднее'},
      {title:'Глубина',value:s?s.depth.toFixed(2):'—',note:'страниц за визит'}, {title:'Время на сайте',value:s?duration(s.duration):'—',note:'среднее'}, {title:'Новые посетители',value:s?pct(s.newVisitors):'—',note:'доля новых'}, {title:'Достижения целей',value:s?fmt.format(s.goals):'—',note:'все цели Метрики'}
    ]);
    chart('siteChart','line',{labels:rows.map(x=>ruDate(x.date)),datasets:[{label:'Визиты',data:rows.map(x=>x.visits),borderColor:'#4457ff',tension:.3,pointRadius:0},{label:'Пользователи',data:rows.map(x=>x.users),borderColor:'#12b76a',tension:.3,pointRadius:0},{label:'Просмотры',data:rows.map(x=>x.pageviews),borderColor:'#f79009',tension:.3,pointRadius:0}]},{plugins:{legend:{display:true,position:'bottom'}}});
    const devices=state.devices.slice(0,8); chart('deviceChart','doughnut',{labels:devices.map(x=>x.name),datasets:[{data:devices.map(x=>x.visits),backgroundColor:['#4457ff','#12b76a','#f79009','#2e90fa','#98a2b3']}]},{plugins:{legend:{display:true,position:'bottom'}}});
    document.getElementById('sourcesTable').innerHTML=state.sources.length?state.sources.map(x=>`<tr><td><strong>${escapeHtml(x.name)}</strong></td><td>${fmt.format(x.visits)}</td><td>${fmt.format(x.users||0)}</td><td>${pct(x.bounce)}</td><td>${fmt.format(x.conversions||0)}</td><td>${pct(x.visits?num(x.conversions)/num(x.visits)*100:0)}</td></tr>`).join(''):`<tr><td colspan="6" class="empty-cell">Нет данных.</td></tr>`;
    const regions=state.regions.slice(0,10), max=Math.max(1,...regions.map(x=>num(x.visits))); document.getElementById('regionList').innerHTML=regions.length?regions.map(x=>`<div class="rank-row"><div><strong>${escapeHtml(x.name)}</strong><span>${fmt.format(x.visits)} визитов</span></div><div class="rank-bar"><i style="width:${Math.max(3,num(x.visits)/max*100)}%"></i></div></div>`).join(''):`<div class="empty-state">Нет данных по регионам.</div>`;
    document.getElementById('goalsTable').innerHTML=state.goals.length?state.goals.map(x=>`<tr><td><strong>${escapeHtml(x.name)}</strong></td><td>${escapeHtml(x.type||'—')}</td><td>${fmt.format(x.reaches||0)}</td><td>${fmt.format(x.visits||0)}</td><td>${pct(x.conversionRate)}</td></tr>`).join(''):`<tr><td colspan="5" class="empty-cell">Цели пока не получены из Метрики.</td></tr>`;
    document.getElementById('pagesTable').innerHTML=state.pages.length?state.pages.map(x=>{const signal=num(x.bounce)>35?statusPill('Проверить','warn'):num(x.conversions)>0?statusPill('Конвертирует','good'):statusPill('Наблюдать','info');return `<tr><td><strong>${escapeHtml(x.title||x.page)}</strong><div class="muted">${escapeHtml(x.page)}</div></td><td>${fmt.format(x.visits)}</td><td>${fmt.format(x.users||0)}</td><td>${pct(x.bounce)}</td><td>${num(x.depth).toFixed(2)}</td><td>${duration(x.duration)}</td><td>${fmt.format(x.conversions||0)}</td><td>${signal}</td></tr>`}).join(''):`<tr><td colspan="8" class="empty-cell">Нет данных по страницам входа.</td></tr>`;
  }

  const problemNames={NO_SITEMAPS:'Нет Sitemap',DISALLOWED_IN_ROBOTS:'Сайт закрыт в robots.txt',DNS_ERROR:'Ошибка DNS',MAIN_PAGE_ERROR:'Ошибка главной страницы',THREATS:'Проблемы безопасности',SLOW_AVG_RESPONSE_TIME:'Медленный ответ сервера',SSL_CERTIFICATE_ERROR:'Ошибка SSL',DOCUMENTS_MISSING_DESCRIPTION:'На многих страницах нет Description',DOCUMENTS_MISSING_TITLE:'На многих страницах нет Title',ERROR_IN_ROBOTS_TXT:'Ошибки robots.txt',ERRORS_IN_SITEMAPS:'Ошибки Sitemap',MAIN_MIRROR_IS_NOT_HTTPS:'Главное зеркало не HTTPS',NO_METRIKA_COUNTER:'Проблема счётчика Метрики',NO_REGIONS:'Не задан регион сайта',NOT_MOBILE_FRIENDLY:'Проблемы мобильной версии'};
  function seoPlan(){
    const items=[]; const fatal=state.seoProblems.filter(x=>x.state==='PRESENT'&&['FATAL','CRITICAL'].includes(x.severity)); if(fatal.length)items.push({level:'high',title:'1. Технические ошибки',text:`Исправить ${fatal.length} критических проблем из Вебмастера до контентных работ.`,action:fatal.map(x=>problemNames[x.code]||x.code).slice(0,3).join(' · ')});
    const lowCtr=state.seo.filter(x=>num(x.shows)>300&&num(x.ctr)<2).sort((a,b)=>b.shows-a.shows); if(lowCtr.length)items.push({level:'high',title:'2. Сниппеты с низким CTR',text:`${lowCtr.length} запросов получают показы, но CTR ниже 2%.`,action:`Начать с: ${lowCtr.slice(0,3).map(x=>x.query).join(' · ')}`});
    const near=state.seo.filter(x=>num(x.position)>=5&&num(x.position)<=15&&num(x.shows)>100).sort((a,b)=>b.shows-a.shows); if(near.length)items.push({level:'medium',title:'3. Страницы рядом с ТОП-5',text:`${near.length} запросов уже находятся на позициях 5–15.`,action:'Усилить соответствие интенту, текст, FAQ и внутренние ссылки.'});
    const falling=state.seo.filter(x=>num(x.delta)<-1).sort((a,b)=>a.delta-b.delta); if(falling.length)items.push({level:'medium',title:'4. Вернуть просевшие позиции',text:`${falling.length} запросов заметно снизились относительно предыдущего периода.`,action:`Проверить: ${falling.slice(0,3).map(x=>x.query).join(' · ')}`});
    if(!items.length&&state.seo.length)items.push({level:'low',title:'Мониторинг и расширение семантики',text:'Критичных проблем по доступным данным не видно.',action:'Расширять страницы под новые запросы и еженедельно отслеживать CTR/позиции.'});
    return items;
  }
  function renderSeo(){
    const s=seoSummary(); renderMetricGrid('seoMetrics',[
      {title:'Показы в поиске',value:s?fmt.format(s.shows):'—',note:'по запросам Вебмастера'}, {title:'Клики из поиска',value:s?fmt.format(s.clicks):'—',note:s?`CTR ${pct(s.ctr)}`:'нет данных'}, {title:'Средняя позиция',value:s?num(s.position).toFixed(1):'—',note:'по доступным запросам'}, {title:'Страниц в поиске',value:s&&s.searchablePages!==undefined?fmt.format(s.searchablePages):'—',note:'Вебмастер'},
      {title:'Исключено страниц',value:s&&s.excludedPages!==undefined?fmt.format(s.excludedPages):'—',note:'не участвуют в поиске'}, {title:'ИКС',value:s&&s.sqi!==undefined?fmt.format(s.sqi):'—',note:'качество сайта'}, {title:'Критические проблемы',value:s?fmt.format(num(s.fatal)+num(s.critical)):'—',note:'Fatal + Critical'}, {title:'Рекомендации Вебмастера',value:s?fmt.format(num(s.recommendation)+num(s.possible)):'—',note:'возможные проблемы'}
    ]);
    const idx=state.seoIndex; chart('seoIndexChart','line',{labels:idx.map(x=>ruDate(x.date)),datasets:[{label:'Страницы в поиске',data:idx.map(x=>x.pagesInSearch),borderColor:'#4457ff',backgroundColor:'rgba(68,87,255,.08)',fill:true,tension:.3,pointRadius:0}]},{plugins:{legend:{display:true,position:'bottom'}}});
    const probs=state.seoProblems.filter(x=>x.state==='PRESENT'); document.getElementById('seoProblems').innerHTML=probs.length?probs.map(x=>issueHtml({level:['FATAL','CRITICAL'].includes(x.severity)?'high':x.severity==='POSSIBLE_PROBLEM'?'medium':'low',title:problemNames[x.code]||x.code,text:`Уровень: ${x.severity}. Последнее изменение: ${x.lastUpdate?new Date(x.lastUpdate).toLocaleDateString('ru-RU'):'—'}.`,action:'Исправить проблему и повторно проверить Вебмастер.'})).join(''):`<div class="empty-state">${state.seoSummary?'Активных проблем Вебмастер не вернул.':'Нет данных диагностики.'}</div>`;
    document.getElementById('seoPlan').innerHTML=seoPlan().map((x,i)=>`<article class="plan-card ${x.level}"><span class="plan-number">${i+1}</span><div><strong>${escapeHtml(x.title.replace(/^\d+\.\s*/,''))}</strong><p>${escapeHtml(x.text)}</p><span>${escapeHtml(x.action)}</span></div></article>`).join('')||'<div class="empty-state">Подключите Вебмастер, чтобы построить план изменений по реальным данным.</div>';
    const sorted=[...state.seo].sort((a,b)=>b.shows-a.shows).slice(0,12); chart('seoChart','bar',{labels:sorted.map(x=>x.query.length>22?x.query.slice(0,20)+'…':x.query),datasets:[{label:'Показы',data:sorted.map(x=>x.shows),backgroundColor:'#d6dcff',borderRadius:7},{label:'Клики × 10',data:sorted.map(x=>x.clicks*10),backgroundColor:'#4457ff',borderRadius:7}]},{plugins:{legend:{display:true,position:'bottom'}}});
    const opp=state.seo.filter(x=>num(x.position)>=5&&num(x.position)<=15&&num(x.shows)>100).sort((a,b)=>b.shows-a.shows).slice(0,5); document.getElementById('seoOpportunities').innerHTML=opp.length?opp.map(x=>issueHtml({level:num(x.position)>10?'medium':'low',title:x.query,text:`${fmt.format(x.shows)} показов · позиция ${num(x.position).toFixed(1)} · CTR ${pct(x.ctr)}`,action:num(x.ctr)<2?'Сначала улучшить Title/Description и соответствие интенту.':'Усилить страницу внутренними ссылками и контентом.'})).join(''):'<div class="empty-state">Пока нет запросов с заметным потенциалом в диапазоне 5–15.</div>';
    renderSeoTable();
  }
  function renderSeoTable(){const q=(document.getElementById('seoSearch')?.value||'').toLowerCase().trim();const rows=state.seo.filter(x=>String(x.query).toLowerCase().includes(q)).sort((a,b)=>b.shows-a.shows);document.getElementById('seoTable').innerHTML=rows.length?rows.map(x=>{const score=num(x.shows)*(Math.max(0,16-num(x.position)))*(Math.max(.25,3-num(x.ctr)));const pr=score>15000?['Высокий','bad']:score>5000?['Средний','warn']:['Низкий','info'];return `<tr><td><strong>${escapeHtml(x.query)}</strong></td><td>${fmt.format(x.shows)}</td><td>${fmt.format(x.clicks)}</td><td>${pct(x.ctr)}</td><td>${num(x.position).toFixed(1)}</td><td class="${num(x.delta)>=0?'num-good':'num-bad'}">${num(x.delta)>0?'+':''}${num(x.delta).toFixed(1)}</td><td>${statusPill(pr[0],pr[1])}</td></tr>`}).join(''):`<tr><td colspan="7" class="empty-cell">Нет запросов.</td></tr>`;}

  function normalizeAdStatus(x){const s=String(x||'').toLowerCase();if(['on','active','активна','активная','работает'].some(k=>s.includes(k)))return ['Активна','good'];if(['suspended','paused','останов','приостанов'].some(k=>s.includes(k)))return ['Остановлена','warn'];if(['inactive','off','неактив'].some(k=>s.includes(k)))return ['Неактивна','warn'];if(['ended','archived','заверш','архив'].some(k=>s.includes(k)))return ['Завершена','info'];return [x&&x!=='unknown'?String(x):'Неизвестно','info'];}
  function renderAds(){
    const days=num(document.getElementById('periodSelect').value||30); const channels=['Все','Яндекс Директ','VK Реклама','Дзен']; document.getElementById('adChannelTabs').innerHTML=channels.map(c=>`<button class="channel-tab ${adChannelFilter===c?'active':''}" data-ad-channel="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');document.querySelectorAll('[data-ad-channel]').forEach(b=>b.addEventListener('click',()=>{adChannelFilter=b.dataset.adChannel;renderAds();}));
    const campaigns=aggregateAds(days,adChannelFilter); const t=adTotals(campaigns); const has=campaigns.length>0||state.adsDaily.some(x=>inPeriod(x.date,days)&&(adChannelFilter==='Все'||x.channel===adChannelFilter));
    renderMetricGrid('adsMetrics',[
      {title:'Расход',value:has?money.format(t.spend):'—',note:`за ${days} дней`},{title:'Показы',value:has?fmt.format(t.impressions):'—',note:'рекламные показы'},{title:'Клики',value:has?fmt.format(t.clicks):'—',note:has?`CTR ${pct(t.impressions?t.clicks/t.impressions*100:0)}`:'нет данных'},{title:'CPC',value:has&&t.clicks?money.format(t.spend/t.clicks):'—',note:'стоимость клика'},
      {title:'Конверсии',value:has?fmt.format(t.conversions):'—',note:has?`CVR ${pct(t.clicks?t.conversions/t.clicks*100:0)}`:'нет данных'},{title:'CPA',value:has&&t.conversions?money.format(t.spend/t.conversions):'—',note:'стоимость конверсии'},{title:'Активные кампании',value:fmt.format(campaigns.filter(x=>normalizeAdStatus(x.status)[0]==='Активна').length),note:'по выбранному каналу'},{title:'Остановленные',value:fmt.format(campaigns.filter(x=>normalizeAdStatus(x.status)[0]==='Остановлена').length),note:'сохраняются как история'}
    ]);
    const daily=(state.adsDaily||[]).filter(x=>inPeriod(x.date,days)&&(adChannelFilter==='Все'||x.channel===adChannelFilter));const dm=new Map();daily.forEach(x=>{const v=dm.get(x.date)||{date:x.date,spend:0,clicks:0,conv:0};v.spend+=num(x.spend);v.clicks+=num(x.clicks);v.conv+=num(x.conversions);dm.set(x.date,v)});const d=[...dm.values()].sort((a,b)=>a.date.localeCompare(b.date));chart('adsChart','line',{labels:d.map(x=>ruDate(x.date)),datasets:[{label:'Расход, ₽',data:d.map(x=>x.spend),borderColor:'#4457ff',tension:.3,pointRadius:0},{label:'Клики',data:d.map(x=>x.clicks),borderColor:'#2e90fa',tension:.3,pointRadius:0},{label:'Конверсии × 10',data:d.map(x=>x.conv*10),borderColor:'#12b76a',tension:.3,pointRadius:0}]},{plugins:{legend:{display:true,position:'bottom'}}});
    const issues=[];campaigns.filter(x=>normalizeAdStatus(x.status)[0]==='Активна').forEach(x=>{if(x.spend>0&&x.conversions===0)issues.push({level:'high',title:`${x.name}: расход без конверсий`,text:`Потрачено ${money.format(x.spend)}, кликов ${fmt.format(x.clicks)}.`,action:'Проверить цели, поисковые запросы/аудитории, посадочную и ставки.'});else if(x.ctr<1&&x.impressions>1000)issues.push({level:'medium',title:`${x.name}: низкий CTR`,text:`CTR ${pct(x.ctr)} при ${fmt.format(x.impressions)} показах.`,action:'Проверить креатив, оффер и соответствие аудитории.'});});document.getElementById('adsIssues').innerHTML=issues.length?issues.slice(0,6).map(issueHtml).join(''):`<div class="empty-state">${campaigns.length?'Явных проблем у активных кампаний по доступным данным нет.':'Нет рекламных данных. Direct подтянется по API; VK и Дзен можно импортировать.'}</div>`;
    document.getElementById('adsTable').innerHTML=campaigns.length?campaigns.sort((a,b)=>b.spend-a.spend).map(x=>{const st=normalizeAdStatus(x.status);return `<tr><td>${statusPill(x.channel||'Реклама','info')}</td><td><strong>${escapeHtml(x.name)}</strong></td><td>${statusPill(st[0],st[1])}</td><td>${fmt.format(x.impressions)}</td><td>${fmt.format(x.clicks)}</td><td>${pct(x.ctr)}</td><td>${money.format(x.spend)}</td><td>${x.clicks?money.format(x.cpc):'—'}</td><td>${fmt.format(x.conversions)}</td><td>${pct(x.cvr)}</td><td>${x.cpa===null?'—':money.format(x.cpa)}</td></tr>`}).join(''):`<tr><td colspan="11" class="empty-cell">Нет кампаний по выбранному каналу.</td></tr>`;
  }

  function renderSocial(){
    const days=num(document.getElementById('periodSelect').value||30), s=socialSummary(days), rows=socialRows(days);renderMetricGrid('socialMetrics',[
      {title:'Публикации',value:s?fmt.format(s.posts):'—',note:`за ${days} дней`},{title:'Охват',value:s?fmt.format(s.reach):'—',note:'суммарный по публикациям'},{title:'Просмотры',value:s?fmt.format(s.views):'—',note:'если канал отдаёт показатель'},{title:'Вовлечения',value:s?fmt.format(s.engagements):'—',note:s?`ER ${pct(s.er)}`:'нет данных'},
      {title:'Клики',value:s?fmt.format(s.clicks):'—',note:'переходы из постов'},{title:'Подписчики',value:s&&s.followers?fmt.format(s.followers):'—',note:'последнее значение по каналам'},{title:'Δ подписчиков',value:s?`${s.followersDelta>0?'+':''}${fmt.format(s.followersDelta)}`:'—',note:'по доступным данным'},{title:'ER',value:s?pct(s.er):'—',note:'реакции + комментарии + репосты / охват'}
    ]);
    const channels=[...new Set(rows.map(x=>x.channel))];chart('socialChart','bar',{labels:channels,datasets:[{label:'Охват',data:channels.map(c=>sum(rows.filter(x=>x.channel===c),'reach')),backgroundColor:'#4457ff',borderRadius:8},{label:'Просмотры',data:channels.map(c=>sum(rows.filter(x=>x.channel===c),'views')),backgroundColor:'#b8c0ff',borderRadius:8}]},{plugins:{legend:{display:true,position:'bottom'}}});
    const top=[...rows].map(x=>({...x,er:x.reach?(num(x.reactions)+num(x.comments)+num(x.shares))/x.reach*100:0})).sort((a,b)=>b.er-a.er).slice(0,4);document.getElementById('contentInsights').innerHTML=top.length?top.map(x=>issueHtml({level:'low',title:x.title,text:`${x.channel}: охват ${fmt.format(x.reach)}, ER ${pct(x.er)}, клики ${fmt.format(x.clicks||0)}.`,action:x.er>=5?'Сохранить тему и механику — формат хорошо вовлекает.':'Сравнить хук, формат и CTA с более сильными постами.'})).join(''):'<div class="empty-state">Импортируйте статистику публикаций, чтобы сравнивать форматы.</div>';
    document.getElementById('socialTable').innerHTML=rows.length?[...rows].sort((a,b)=>String(b.date).localeCompare(String(a.date))).map(x=>{const er=x.reach?(num(x.reactions)+num(x.comments)+num(x.shares))/x.reach*100:0;return `<tr><td>${statusPill(x.channel||'Канал','info')}</td><td><strong>${escapeHtml(x.title||'Публикация')}</strong></td><td>${ruDate(x.date)}</td><td>${fmt.format(x.reach||0)}</td><td>${fmt.format(x.views||0)}</td><td>${fmt.format(x.reactions||0)}</td><td>${fmt.format(x.comments||0)}</td><td>${fmt.format(x.shares||0)}</td><td>${fmt.format(x.clicks||0)}</td><td>${pct(er)}</td></tr>`}).join(''):`<tr><td colspan="10" class="empty-cell">Нет данных соцсетей.</td></tr>`;
  }

  function renderEmail(){
    const days=num(document.getElementById('periodSelect').value||30), e=emailSummary(days), rows=emailRows(days);renderMetricGrid('emailMetrics',[
      {title:'Отправлено',value:e?fmt.format(e.sent):'—',note:`за ${days} дней`},{title:'Доставлено',value:e?fmt.format(e.delivered):'—',note:e?`Delivery Rate ${pct(e.deliveryRate)}`:'нет данных'},{title:'Open Rate',value:e?pct(e.openRate):'—',note:e?`${fmt.format(e.opened)} уникальных открытий`:'нет данных'},{title:'CTR',value:e?pct(e.ctr):'—',note:e?`${fmt.format(e.clicked)} уникальных кликов`:'нет данных'},
      {title:'Ошибки доставки',value:e?fmt.format(e.errors):'—',note:'sent − delivered'},{title:'Отписки',value:e?fmt.format(e.unsub):'—',note:e?pct(e.unsubRate,2):'нет данных'},{title:'Жалобы на спам',value:e?fmt.format(e.spam):'—',note:'по данным UniSender'},{title:'Клики',value:e?fmt.format(e.clicked):'—',note:'уникальные переходы'}
    ]);
    const sorted=[...rows].sort((a,b)=>String(a.date).localeCompare(String(b.date)));chart('emailChart','line',{labels:sorted.map(x=>ruDate(x.date)),datasets:[{label:'Open Rate',data:sorted.map(x=>x.delivered?num(x.opened)/num(x.delivered)*100:0),borderColor:'#4457ff',tension:.3},{label:'CTR',data:sorted.map(x=>x.delivered?num(x.clicked)/num(x.delivered)*100:0),borderColor:'#12b76a',tension:.3}]},{plugins:{legend:{display:true,position:'bottom'}}});
    const issues=[];if(e){if(e.deliveryRate<95)issues.push({level:'medium',title:'Доставляемость ниже 95%',text:`Delivery Rate ${pct(e.deliveryRate)}.`,action:'Проверить качество базы и причины недоставок.'});if(e.unsubRate>.5)issues.push({level:'high',title:'Повышенные отписки',text:`Отписки ${pct(e.unsubRate,2)}.`,action:'Проверить частоту отправок, сегментацию и соответствие ожиданиям базы.'});if(e.openRate>0&&e.ctr<1)issues.push({level:'medium',title:'Открывают, но мало переходят',text:`Open Rate ${pct(e.openRate)}, CTR ${pct(e.ctr)}.`,action:'Усилить содержание письма, оффер и CTA.'});}document.getElementById('emailIssues').innerHTML=issues.length?issues.map(issueHtml).join(''):`<div class="empty-state">${e?'Явных проблем по агрегатам нет.':'Добавьте UNISENDER_API_KEY, чтобы получать статистику автоматически.'}</div>`;
    document.getElementById('emailTable').innerHTML=rows.length?[...rows].sort((a,b)=>String(b.date).localeCompare(String(a.date))).map(x=>{const or=x.delivered?num(x.opened)/num(x.delivered)*100:0,ctr=x.delivered?num(x.clicked)/num(x.delivered)*100:0;const cls=or>=25&&ctr>=2?'good':or<15?'warn':'info';return `<tr><td><strong>${escapeHtml(x.name)}</strong></td><td>${ruDate(x.date)}</td><td>${fmt.format(x.sent||0)}</td><td>${fmt.format(x.delivered||0)}</td><td>${pct(or)}</td><td>${pct(ctr)}</td><td>${fmt.format(x.errors||0)}</td><td>${fmt.format(x.unsub||0)}</td><td>${fmt.format(x.spam||0)}</td><td>${statusPill(cls==='good'?'Сильная':cls==='warn'?'Проверить':'Норма',cls)}</td></tr>`}).join(''):`<tr><td colspan="10" class="empty-cell">Нет данных рассылок.</td></tr>`;
  }

  function autoTasks(){
    const tasks=[];getOverviewIssues(num(document.getElementById('periodSelect').value||30)).forEach((x,i)=>tasks.push({id:`auto-overview-${i}`,title:x.action||x.title,priority:x.level==='high'?'high':x.level==='medium'?'medium':'low',source:'Автодиагностика'}));seoPlan().forEach((x,i)=>tasks.push({id:`auto-seo-${i}`,title:x.action||x.title,priority:x.level==='high'?'high':x.level==='medium'?'medium':'low',source:'SEO'}));
    const ads=aggregateAds(num(document.getElementById('periodSelect').value||30));ads.filter(x=>normalizeAdStatus(x.status)[0]==='Активна'&&x.spend>0&&x.conversions===0).slice(0,3).forEach((x,i)=>tasks.push({id:`auto-ads-${i}`,title:`Разобрать кампанию «${x.name}»: расход есть, конверсий нет`,priority:'high',source:'Реклама'}));return tasks;
  }
  function renderTasks(){const items=[...autoTasks(),...(local.manualTasks||[])];const done=local.doneTasks||{};const order={high:0,medium:1,low:2};items.sort((a,b)=>order[a.priority]-order[b.priority]);document.getElementById('taskList').innerHTML=items.length?items.map(x=>`<div class="task-item ${done[x.id]?'done':''}"><input class="task-check" type="checkbox" data-task="${escapeHtml(x.id)}" ${done[x.id]?'checked':''}/><div><div class="task-title">${escapeHtml(x.title)}</div><div class="task-meta">${escapeHtml(x.source||'Своя задача')}</div></div><span class="priority ${x.priority}">${x.priority==='high'?'Высокий':x.priority==='medium'?'Средний':'Низкий'}</span></div>`).join(''):'<div class="empty-state">Задач пока нет.</div>';document.getElementById('focusSteps').innerHTML=items.filter(x=>!done[x.id]).slice(0,5).map(x=>`<li>${escapeHtml(x.title)}</li>`).join('')||'<li>Критичных задач по доступным данным нет.</li>';document.querySelectorAll('[data-task]').forEach(el=>el.addEventListener('change',e=>{local.doneTasks=local.doneTasks||{};local.doneTasks[e.target.dataset.task]=e.target.checked;saveLocal();renderTasks();}));}

  function reportSnapshot(days){return {generatedAt:new Date().toISOString(),periodDays:days,site:siteSummary(days),seo:seoSummary(),ads:aggregateAds(days),social:socialSummary(days),email:emailSummary(days),issues:getOverviewIssues(days),seoPlan:seoPlan(),tasks:autoTasks()};}
  function renderReports(){const d=reportSnapshot(num(document.getElementById('reportPeriod').value||30));const rows=[['Визиты',d.site?fmt.format(d.site.visits):'—'],['Заявки',d.site?fmt.format(d.site.formSubmits):'—'],['SEO-клики',d.seo?fmt.format(d.seo.clicks):'—'],['Рекламный расход',d.ads.length?money.format(adTotals(d.ads).spend):'—'],['Email CTR',d.email?pct(d.email.ctr):'—'],['Активные задачи',fmt.format(autoTasks().length)]];document.getElementById('reportPreview').innerHTML=rows.map(r=>`<div class="preview-row"><span>${r[0]}</span><strong>${r[1]}</strong></div>`).join('');}
  function selectedSections(){return [...document.querySelectorAll('.reportCheck:checked')].map(x=>x.value);}
  function buildReportHtml(){const days=num(document.getElementById('reportPeriod').value||30),d=reportSnapshot(days),selected=selectedSections(),title=escapeHtml(document.getElementById('reportName').value||'Маркетинговый отчёт');const k=(l,v)=>`<div class="pdf-kpi"><span>${escapeHtml(l)}</span><strong>${v}</strong></div>`;let h=`<div class="pdf-report"><h1>${title}</h1><div class="report-date">Последние ${days} дней · ${new Date().toLocaleString('ru-RU')}</div>`;if(selected.includes('overview'))h+=`<h2>Сводка</h2><div class="pdf-kpis">${k('Визиты',d.site?fmt.format(d.site.visits):'—')}${k('Заявки',d.site?fmt.format(d.site.formSubmits):'—')}${k('Email-клики',d.site?fmt.format(d.site.emailClicks):'—')}${k('SEO-клики',d.seo?fmt.format(d.seo.clicks):'—')}</div>`;if(selected.includes('site')&&d.site)h+=`<h2>Сайт</h2><p>Визиты: <strong>${fmt.format(d.site.visits)}</strong> · пользователи: <strong>${fmt.format(d.site.users)}</strong> · отказы: <strong>${pct(d.site.bounce)}</strong> · глубина: <strong>${d.site.depth.toFixed(2)}</strong> · время: <strong>${duration(d.site.duration)}</strong>.</p>`;if(selected.includes('seo')&&d.seo)h+=`<h2>SEO</h2><p>Показы: <strong>${fmt.format(d.seo.shows)}</strong> · клики: <strong>${fmt.format(d.seo.clicks)}</strong> · CTR: <strong>${pct(d.seo.ctr)}</strong> · позиция: <strong>${num(d.seo.position).toFixed(1)}</strong> · страниц в поиске: <strong>${fmt.format(d.seo.searchablePages||0)}</strong>.</p>`;if(selected.includes('ads')){const t=adTotals(d.ads);h+=`<h2>Реклама</h2><p>Расход: <strong>${money.format(t.spend)}</strong> · показы: <strong>${fmt.format(t.impressions)}</strong> · клики: <strong>${fmt.format(t.clicks)}</strong> · конверсии: <strong>${fmt.format(t.conversions)}</strong>.</p>`;}if(selected.includes('social')&&d.social)h+=`<h2>Соцсети</h2><p>Публикации: <strong>${fmt.format(d.social.posts)}</strong> · охват: <strong>${fmt.format(d.social.reach)}</strong> · ER: <strong>${pct(d.social.er)}</strong>.</p>`;if(selected.includes('email')&&d.email)h+=`<h2>Email</h2><p>Отправлено: <strong>${fmt.format(d.email.sent)}</strong> · доставлено: <strong>${fmt.format(d.email.delivered)}</strong> · Open Rate: <strong>${pct(d.email.openRate)}</strong> · CTR: <strong>${pct(d.email.ctr)}</strong>.</p>`;if(selected.includes('recommendations'))h+=`<h2>Рекомендации</h2>${[...d.issues,...d.seoPlan].map(x=>`<div class="pdf-reco"><strong>${escapeHtml(x.title)}</strong><span>${escapeHtml(x.text)} ${escapeHtml(x.action||'')}</span></div>`).join('')}`;return h+'</div>';}
  async function downloadPdf(){const box=document.getElementById('reportCanvas');box.innerHTML=buildReportHtml();if(window.html2pdf)await html2pdf().set({margin:[9,9,9,9],filename:`cs-marketing-${iso(today)}.pdf`,image:{type:'jpeg',quality:.96},html2canvas:{scale:2,useCORS:true},jsPDF:{unit:'mm',format:'a4',orientation:'portrait'}}).from(box.firstElementChild).save();else window.print();}
  function downloadBlob(content,name,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);}
  function downloadJson(){downloadBlob(JSON.stringify(reportSnapshot(num(document.getElementById('reportPeriod').value||30)),null,2),`cs-marketing-${iso(today)}.json`,'application/json');}
  function downloadCsv(){const d=reportSnapshot(30),a=adTotals(d.ads);const rows=[['section','metric','value'],['site','visits',d.site?.visits??''],['site','formSubmits',d.site?.formSubmits??''],['site','emailClicks',d.site?.emailClicks??''],['seo','clicks',d.seo?.clicks??''],['ads','spend',a.spend],['ads','conversions',a.conversions],['email','ctr',d.email?.ctr??'']];downloadBlob('\uFEFF'+rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(';')).join('\n'),`cs-marketing-${iso(today)}.csv`,'text/csv;charset=utf-8');}

  const integrations=[
    {id:'metrika',name:'Яндекс Метрика',desc:'Трафик, источники, страницы, устройства, регионы, цели и Вебвизор.',kind:'api',setup:'YANDEX_TOKEN + SITE_URL. METRIKA_COUNTER_ID нужен только если автоопределение не сработает.'},
    {id:'webmaster',name:'Яндекс Вебмастер',desc:'Запросы, позиции, CTR, индексация, ИКС и диагностика.',kind:'api',setup:'Тот же YANDEX_TOKEN + SITE_URL. WEBMASTER_HOST_ID — только запасной ручной идентификатор.'},
    {id:'direct',name:'Яндекс Директ',desc:'Кампании, реальные статусы, расход, показы, клики и конверсии.',kind:'api',setup:'Отдельный DIRECT_TOKEN. Для приложения должен быть одобрен доступ к Direct API.'},
    {id:'vkads',name:'VK Реклама',desc:'Кампании, статусы, показы, клики и расход из нового кабинета ads.vk.com.',kind:'api',setup:'VK_ADS_CLIENT_ID + VK_ADS_CLIENT_SECRET. Приложение само получает временный access token.'},
    {id:'unisender',name:'UniSender',desc:'Рассылки, доставка, уникальные открытия, клики, отписки и жалобы.',kind:'api',setup:'UNISENDER_API_KEY из настроек «Интеграция и API».'},
    {id:'vksocial',name:'VK — сообщество',desc:'Органический контент пока через импорт. API сообщества подключим отдельно после выбора схемы доступа.',kind:'manual',source:'social'},
    {id:'telegram',name:'Telegram',desc:'Полная статистика канала требует MTProto-авторизацию пользователя-администратора; простого bot token недостаточно.',kind:'mtproto',source:'social'},
    {id:'dzenads',name:'Дзен — реклама',desc:'Отдельный ручной канал. Если размещение идёт через Яндекс Директ, расходы уже попадут из Директа.',kind:'manual',source:'ads'},
    {id:'dzensocial',name:'Дзен — публикации',desc:'Пока импорт Excel/CSV: показы, дочитывания/просмотры, реакции, клики и подписчики, если они есть в выгрузке.',kind:'manual',source:'social'},
    {id:'maxsocial',name:'MAX',desc:'Посты канала и доступная статистика просмотров/репостов через официальный Bot API.',kind:'api',setup:'MAX_BOT_TOKEN + MAX_CHANNEL_ID. Бот должен быть администратором канала.'}
  ];
  function renderIntegrations(){
    const grid=document.getElementById('integrationGrid');
    grid.innerHTML=integrations.map(x=>{
      const st=apiStatus.integrations?.[x.id]||{};
      const configured=Boolean(st.configured??st.connected);
      const last=st.lastSync?`Последняя синхронизация: ${escapeHtml(st.lastSync)}`:'';
      const missing=Array.isArray(st.missing)&&st.missing.length?`Не хватает: ${st.missing.map(escapeHtml).join(', ')}`:'';
      const message=st.message?escapeHtml(st.message):'';
      let label='Ручной импорт',cls='info';
      if(x.kind==='api'){label=configured?'Настроено':'Нужны доступы';cls=configured?'good':'warn';}
      if(x.kind==='mtproto'){label='Отдельное подключение';cls='info';}
      const meta=[last,missing,message].filter(Boolean).join('<br>') || escapeHtml(x.setup||'Импорт доступен уже сейчас.');
      const actions=x.kind==='api'
        ? `<button class="secondary-btn sync-one" data-source="${x.id}" ${configured?'':'disabled'}>Синхронизировать</button>`
        : `<button class="secondary-btn import-one" data-source="${x.source||'social'}">Импортировать</button>`;
      return `<article class="integration-card"><div class="integration-top"><div class="integration-name">${escapeHtml(x.name)}</div>${statusPill(label,cls)}</div><div class="integration-desc">${escapeHtml(x.desc)}</div><div class="integration-setup">${escapeHtml(x.setup||'')}</div><div class="integration-meta">${meta}</div><div class="integration-actions">${actions}</div></article>`;
    }).join('');
    document.querySelectorAll('.sync-one').forEach(b=>b.addEventListener('click',()=>syncSource(b.dataset.source)));
    document.querySelectorAll('.import-one').forEach(b=>b.addEventListener('click',()=>{document.getElementById('importSource').value=b.dataset.source;document.getElementById('fileInput').click();}));
    renderCredentialChecklist();
  }
  function renderCredentialChecklist(){
    const el=document.getElementById('credentialChecklist'); if(!el)return;
    const rows=[
      ['SITE_URL','Variable','https://www.cs-trade.ru/','Нужна для автоопределения счётчика Метрики и сайта Вебмастера.'],
      ['YANDEX_TOKEN','Secret','OAuth token','Один токен можно использовать для Метрики и Вебмастера, если при выдаче есть оба доступа.'],
      ['METRIKA_COUNTER_ID','Variable','необязательно','Только если SITE_URL не смог однозначно выбрать счётчик.'],
      ['WEBMASTER_HOST_ID','Variable','необязательно','Только если SITE_URL не смог однозначно выбрать хост.'],
      ['DIRECT_TOKEN','Secret','OAuth token','Директ использует отдельный токен приложения с одобренным доступом к API.'],
      ['DIRECT_CLIENT_LOGIN','Variable','необязательно','Нужен в основном для агентского доступа к клиентскому кабинету.'],
      ['VK_ADS_CLIENT_ID','Variable','ID из VK Рекламы','Идентификатор API-клиента.'],
      ['VK_ADS_CLIENT_SECRET','Secret','секрет из VK Рекламы','Хранить только как Secret. Worker сам получает access token.'],
      ['VK_ADS_TOKEN','Secret','необязательно','Запасной вариант: готовый access token вместо client_id/client_secret.'],
      ['MAX_BOT_TOKEN','Secret','токен бота MAX','Бот должен быть администратором канала, чтобы читать посты через API.'],
      ['MAX_CHANNEL_ID','Variable','ID канала MAX','Канал, статистику которого загружает приложение.'],
      ['UNISENDER_API_KEY','Secret','API key','Ключ доступа к статистике рассылок.']
    ];
    el.innerHTML=rows.map(r=>`<tr><td><code>${r[0]}</code></td><td>${statusPill(r[1],r[1]==='Secret'?'warn':'info')}</td><td>${escapeHtml(r[2])}</td><td>${escapeHtml(r[3])}</td></tr>`).join('');
  }
  async function fetchApiStatus(){try{const r=await apiFetch('/api/status',{headers:{Accept:'application/json'}});if(!r.ok)throw new Error('status');apiStatus=await r.json();const connected=Object.values(apiStatus.integrations||{}).filter(x=>x.connected).length;document.getElementById('syncDot').className=`dot ${connected?'live':'warn'}`;document.getElementById('syncText').textContent=connected?`API настроено: ${connected}`:'API пока не настроены';}catch{apiStatus={mode:'empty',integrations:{}};document.getElementById('syncDot').className='dot warn';document.getElementById('syncText').textContent='Нет связи с API';}renderIntegrations();renderOverview();}
  async function syncSource(source){showAlert(`Синхронизирую ${source}…`);try{const r=await apiFetch(`/api/sync/${source}`,{method:'POST'});const out=await r.json();if(!r.ok)throw new Error(out.error||'Ошибка синхронизации');showAlert(out.message||'Данные обновлены','success');await loadLiveData();await fetchApiStatus();}catch(e){showAlert(e.message||'Не удалось синхронизировать','error');}}
  async function syncAll(){const connected=Object.entries(apiStatus.integrations||{}).filter(([,v])=>v.connected).map(([k])=>k).filter(k=>['metrika','webmaster','direct','vkads','unisender','maxsocial'].includes(k));if(!connected.length){showAlert('Серверные источники пока не подключены. Открой раздел «Интеграции».');return;}for(const s of connected)await syncSource(s);}
  async function loadLiveData(){try{const r=await apiFetch('/api/dashboard');if(!r.ok)throw new Error('dashboard');const live=await r.json();state={...blank(),...live,meta:{...blank().meta,...(live.meta||{})}};renderAll();}catch(e){showAlert('Не удалось загрузить данные с сервера. Ложные демо-цифры не подставляются.','error');renderAll();}}

  function val(row, names){for(const n of names){const k=Object.keys(row).find(x=>x.trim().toLowerCase()===n.toLowerCase());if(k!==undefined){const v=row[k];if(typeof v==='number')return v;const s=String(v??'').replace(/\s/g,'').replace(',','.').replace(/[^0-9.\-]/g,'');const x=Number(s);if(Number.isFinite(x))return x;}}return 0;}
  function textVal(row,names,fallback=''){for(const n of names){const k=Object.keys(row).find(x=>x.trim().toLowerCase()===n.toLowerCase());if(k!==undefined&&row[k]!==undefined&&row[k]!==null&&String(row[k]).trim())return String(row[k]).trim();}return fallback;}
  function dateVal(row){const raw=textVal(row,['дата','date','start_time','дата публикации','дата рассылки']);if(raw){const d=new Date(raw);if(!Number.isNaN(d.getTime()))return iso(d);}return iso(new Date());}
  async function readRows(file){const ext=file.name.split('.').pop().toLowerCase();if(ext==='json'){const x=JSON.parse(await file.text());return Array.isArray(x)?x:(x.rows||x.data||[]);}if(ext==='csv'){const text=await file.text();if(window.XLSX){const wb=XLSX.read(text,{type:'string'});return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});}}if(window.XLSX){const wb=XLSX.read(await file.arrayBuffer(),{type:'array'});return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});}throw new Error('Не удалось прочитать файл.');}
  async function importFile(file){const source=document.getElementById('importSource').value,mode=document.getElementById('importMode').value,rows=await readRows(file);let parsed=[];
    if(source==='site')parsed=rows.map(r=>({date:dateVal(r),visits:val(r,['визиты','visits','sessions']),users:val(r,['посетители','users']),pageviews:val(r,['просмотры','pageviews']),bounceRate:val(r,['отказы','bounce rate','bouncerate']),depth:val(r,['глубина','depth']),duration:val(r,['время','duration']),conversions:val(r,['цели','конверсии','conversions']),newVisitors:val(r,['новые посетители','new visitors','percent new visitors']),emailClicks:val(r,['клики по email','email clicks']),formSubmits:val(r,['заявки','form submits','отправки форм'])})).filter(x=>x.visits||x.users||x.pageviews||x.conversions);
    if(source==='seo')parsed=rows.map(r=>({query:textVal(r,['запрос','query','поисковый запрос']),shows:val(r,['показы','shows','impressions']),clicks:val(r,['клики','clicks']),ctr:val(r,['ctr','кликабельность']),position:val(r,['позиция','position','avg position']),delta:val(r,['изменение позиции','delta','динамика'])})).filter(x=>x.query);
    if(source==='ads')parsed=rows.map(r=>({channel:textVal(r,['канал','channel','площадка'],'Реклама'),name:textVal(r,['кампания','campaign','campaign name','название'],'Импортированная кампания'),campaignId:textVal(r,['id кампании','campaign id','campaignid']),status:textVal(r,['статус','status'],'unknown'),date:dateVal(r),impressions:val(r,['показы','impressions']),clicks:val(r,['клики','clicks']),spend:val(r,['расход','cost','spend','затраты']),conversions:val(r,['конверсии','conversions','goals'])})).filter(x=>x.name);
    if(source==='social')parsed=rows.map(r=>({channel:textVal(r,['канал','channel','соцсеть','platform'],'Импорт'),title:textVal(r,['публикация','title','пост','post','материал'],'Публикация'),date:dateVal(r),reach:val(r,['охват','reach']),views:val(r,['просмотры','views','impressions']),reactions:val(r,['реакции','reactions','лайки','likes']),comments:val(r,['комментарии','comments']),shares:val(r,['репосты','shares','reposts']),clicks:val(r,['клики','clicks','переходы']),followers:val(r,['подписчики','followers','subscribers']),followersDelta:val(r,['прирост подписчиков','followers delta','subscriber delta'])})).filter(x=>x.reach||x.views||x.reactions||x.comments||x.shares||x.clicks);
    if(source==='email')parsed=rows.map(r=>({id:textVal(r,['id','campaign_id']),name:textVal(r,['рассылка','name','campaign','тема','subject'],'Рассылка'),date:dateVal(r),status:textVal(r,['статус','status']),sent:val(r,['отправлено','sent']),delivered:val(r,['доставлено','delivered']),opened:val(r,['открытия','opened','read_unique']),clicked:val(r,['клики','clicked','clicked_unique']),unsub:val(r,['отписки','unsub','unsubscribed']),spam:val(r,['спам','spam']),errors:val(r,['ошибки','errors','bounces'])})).filter(x=>x.sent||x.delivered||x.opened||x.clicked);
    if(!parsed.length)throw new Error('Не удалось сопоставить колонки файла с выбранным разделом.');const r=await apiFetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,rows:parsed,mode})});const out=await r.json().catch(()=>({}));if(!r.ok)throw new Error(out.error||'Сервер не принял импорт');document.getElementById('importLog').innerHTML=`<strong>${escapeHtml(file.name)}</strong>: импортировано ${parsed.length} строк.`;showAlert(`Импортировано ${parsed.length} строк`,'success');await loadLiveData();}

  function showAlert(text,type=''){const el=document.getElementById('globalAlert');el.textContent=text;el.className=`alert ${type}`;el.hidden=false;clearTimeout(showAlert.timer);showAlert.timer=setTimeout(()=>el.hidden=true,6000);}
  function navigate(view){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===view));document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));const copy={overview:['Обзор сайта и обращений','Посещения, заявки, email-клики, источники трафика и быстрый доступ к Вебвизору.'],site:['Сайт','Подробная Метрика: поведение, цели, устройства, регионы и страницы.'],seo:['SEO','Вебмастер, индексация, диагностика, запросы и план изменений сайта.'],ads:['Реклама','Яндекс Директ, VK Реклама и Дзен: деньги, клики, конверсии и статусы кампаний.'],social:['Соцсети','VK, Telegram, MAX и Дзен: контент, охват, просмотры и вовлечённость.'],email:['Email','UniSender: доставка, открытия, клики, отписки и жалобы.'],tasks:['Задачи','Автоматический план действий по реальным проблемам.'],reports:['Отчёты','Отчёт руководителю в PDF, JSON или CSV.'],integrations:['Интеграции','API и ручные импорты без выдуманных демо-данных.']}[view];document.getElementById('pageTitle').textContent=copy[0];document.getElementById('pageSubtitle').textContent=copy[1];document.getElementById('sidebar').classList.remove('open');}
  function renderAll(){renderOverview();renderSite();renderSeo();renderAds();renderSocial();renderEmail();renderTasks();renderReports();renderIntegrations();}

  document.getElementById('loginForm').addEventListener('submit',login);
  document.getElementById('logoutBtn').addEventListener('click',logout);
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
  document.getElementById('mobileMenuBtn').addEventListener('click',()=>document.getElementById('sidebar').classList.toggle('open'));
  document.getElementById('periodSelect').addEventListener('change',renderAll);
  document.getElementById('seoSearch').addEventListener('input',renderSeoTable);
  document.getElementById('syncBtn').addEventListener('click',syncAll);
  document.getElementById('syncAllBtn')?.addEventListener('click',syncAll);
  document.getElementById('quickReportBtn').addEventListener('click',downloadPdf);
  document.getElementById('generateReportBtn').addEventListener('click',downloadPdf);
  document.getElementById('downloadJsonBtn').addEventListener('click',downloadJson);
  document.getElementById('downloadCsvBtn').addEventListener('click',downloadCsv);
  document.getElementById('reportPeriod').addEventListener('change',renderReports);
  document.querySelectorAll('.reportCheck').forEach(x=>x.addEventListener('change',renderReports));
  document.getElementById('reportName').addEventListener('input',renderReports);
  document.getElementById('importBtn').addEventListener('click',()=>document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;try{await importFile(f);}catch(err){showAlert(err.message||'Ошибка импорта','error');}e.target.value='';});
  document.getElementById('clearLocalBtn').addEventListener('click',()=>{local.manualTasks=[];local.doneTasks={};saveLocal();renderTasks();showAlert('Локальный кэш задач очищен. Серверные данные не затронуты.','success');});
  document.getElementById('addTaskBtn').addEventListener('click',()=>document.getElementById('taskDialog').showModal());
  document.getElementById('taskForm').addEventListener('submit',e=>{e.preventDefault();const title=document.getElementById('taskTitleInput').value.trim();if(!title)return;local.manualTasks=local.manualTasks||[];local.manualTasks.push({id:`manual-${Date.now()}`,title,priority:document.getElementById('taskPriorityInput').value,source:'Своя задача'});saveLocal();document.getElementById('taskTitleInput').value='';document.getElementById('taskDialog').close();renderTasks();});

  initAuth();
})();
