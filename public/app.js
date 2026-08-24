(() => {
  'use strict';

  const fmt = new Intl.NumberFormat('ru-RU');
  const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
  const pct = (v, d = 1) => `${Number(v || 0).toFixed(d).replace('.', ',')}%`;
  const n = (v) => Number(v || 0);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const sum = (arr, key) => arr.reduce((a, x) => a + n(typeof key === 'function' ? key(x) : x[key]), 0);
  const avg = (arr, key) => arr.length ? sum(arr, key) / arr.length : 0;
  const today = new Date();
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const ruDate = (s) => new Date(`${s}T12:00:00`).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  function dayOffset(days) {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return iso(d);
  }

  const demo = {
    site: Array.from({length: 90}, (_, i) => {
      const wave = Math.sin(i / 5) * 10;
      const trend = i * .18;
      const visits = Math.max(18, Math.round(42 + wave + trend + ((i * 17) % 13)));
      const users = Math.round(visits * (.67 + ((i % 5) * .02)));
      const conversions = Math.max(0, Math.round(visits * (.018 + (i % 7 === 0 ? .012 : 0))));
      return { date: dayOffset(i - 89), visits, users, pageviews: Math.round(visits * 3.6), bounceRate: 13 + (i % 8) * 1.2, depth: 3.2 + (i % 6) * .18, duration: 215 + (i % 7) * 14, conversions };
    }),
    sources: [
      {name:'Поиск', visits:742, change:18, conversions:14}, {name:'Прямые', visits:218, change:5, conversions:3},
      {name:'VK', visits:94, change:-21, conversions:1}, {name:'Telegram', visits:61, change:14, conversions:1},
      {name:'Директ', visits:186, change:32, conversions:5}, {name:'Прочее', visits:73, change:-3, conversions:0}
    ],
    pages: [
      {page:'/catalog/gibkaya-podvodka/', title:'Гибкая подводка', visits:284, bounce:10.8, depth:4.6, conversions:7},
      {page:'/catalog/smesiteli/', title:'Смесители', visits:201, bounce:14.1, depth:3.9, conversions:5},
      {page:'/dealer/', title:'Стать дилером', visits:124, bounce:22.5, depth:2.7, conversions:4},
      {page:'/product/cs-sm-294/', title:'Смеситель ЦС-СМ 294', visits:93, bounce:8.9, depth:5.1, conversions:2},
      {page:'/blog/legionella/', title:'Легионелла в водопроводе', visits:77, bounce:18.1, depth:2.8, conversions:0},
      {page:'/catalog/dushevye-sistemy/', title:'Душевые системы', visits:61, bounce:36.5, depth:1.8, conversions:0}
    ],
    seo: [
      {query:'центр сантехники официальный сайт', shows:1840, clicks:213, ctr:11.6, position:2.4, delta:1.2},
      {query:'гибкая подводка оптом', shows:3260, clicks:82, ctr:2.5, position:8.7, delta:2.8},
      {query:'производитель гибкой подводки', shows:1940, clicks:57, ctr:2.9, position:7.9, delta:1.6},
      {query:'смесители оптом от производителя', shows:2810, clicks:41, ctr:1.5, position:12.2, delta:-3.7},
      {query:'смеситель цс', shows:820, clicks:76, ctr:9.3, position:4.1, delta:.9},
      {query:'сантехника оптом для магазина', shows:1560, clicks:19, ctr:1.2, position:14.8, delta:-1.4},
      {query:'гибкая подводка 1 2 500 мм', shows:1120, clicks:38, ctr:3.4, position:9.2, delta:2.1},
      {query:'центр сантехники подольск', shows:740, clicks:138, ctr:18.6, position:1.8, delta:.2}
    ],
    ads: [
      {name:'Яндекс — дилеры поиск', impressions:18840, clicks:612, spend:15280, conversions:12},
      {name:'Яндекс — товарная', impressions:29420, clicks:804, spend:13210, conversions:15},
      {name:'VK — дилеры', impressions:62140, clicks:280, spend:14960, conversions:1},
      {name:'Ретаргетинг', impressions:10420, clicks:316, spend:4820, conversions:8}
    ],
    adsDaily: Array.from({length: 30}, (_, i) => ({date:dayOffset(i-29), spend: 780 + ((i*83)%520), clicks: 35+((i*13)%28), conversions: (i%4===0?3:(i%3===0?2:1))})),
    social: [
      {channel:'Telegram', title:'Убийца жил внутри трубы: легионелла', date:dayOffset(-4), reach:1840, reactions:141},
      {channel:'VK', title:'Как устроена гибкая подводка', date:dayOffset(-6), reach:4230, reactions:172},
      {channel:'Дзен', title:'Почему человечество тысячу лет не могло сделать нормальный смеситель', date:dayOffset(-9), reach:2760, reactions:95},
      {channel:'Telegram', title:'Собери комплект: что подходит к смесителю?', date:dayOffset(-12), reach:1320, reactions:118},
      {channel:'VK', title:'Смеситель ЦС-СМ 294 в интерьере', date:dayOffset(-15), reach:3520, reactions:74},
      {channel:'MAX', title:'Как проверить подводку перед установкой', date:dayOffset(-18), reach:780, reactions:31}
    ],
    email: [
      {name:'Новинки августа', date:dayOffset(-5), sent:2480, opened:684, clicked:129, unsub:8, errors:31},
      {name:'Предложение для дилеров', date:dayOffset(-18), sent:2310, opened:510, clicked:72, unsub:13, errors:36},
      {name:'Гибкая подводка: ассортимент', date:dayOffset(-33), sent:2250, opened:702, clicked:168, unsub:6, errors:25}
    ],
    tasks: [
      {id:'t1', title:'Пересобрать VK-кампанию: оффер + аудитории', priority:'high', source:'Реклама', done:false},
      {id:'t2', title:'Проверить падение запросов по смесителям', priority:'high', source:'SEO', done:false},
      {id:'t3', title:'Обновить сниппеты страниц с большим числом показов и CTR < 2%', priority:'medium', source:'SEO', done:false},
      {id:'t4', title:'Проверить страницу душевых систем: высокий показатель отказов', priority:'medium', source:'Сайт', done:false},
      {id:'t5', title:'Повторить экспертный формат Telegram: история + сантехника', priority:'low', source:'Контент', done:false}
    ]
  };

  let state = loadState();
  let charts = {};
  let apiStatus = { mode: 'demo', integrations: {} };
  let currentUser = null;

  const AUTH_TOKEN_KEY = 'cs-marketing-auth-token';

  function getFallbackToken() {
    try { return sessionStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch { return ''; }
  }

  function setFallbackToken(token) {
    try {
      if (token) sessionStorage.setItem(AUTH_TOKEN_KEY, token);
      else sessionStorage.removeItem(AUTH_TOKEN_KEY);
    } catch {}
  }

  async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = getFallbackToken();
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(url, { ...options, headers, credentials: 'include', cache: options.cache || 'no-store' });
    if (response.status === 401) {
      setFallbackToken('');
      showAuthScreen('Сессия закончилась. Войдите снова.');
      throw new Error('Требуется авторизация');
    }
    return response;
  }

  function showAuthScreen(message = '') {
    currentUser = null;
    document.getElementById('appShell').hidden = true;
    document.getElementById('authScreen').hidden = false;
    const err = document.getElementById('authError');
    err.textContent = message;
    err.hidden = !message;
    document.getElementById('passwordInput').value = '';
    setTimeout(() => document.getElementById('loginInput').focus(), 0);
  }

  async function showApp(user) {
    currentUser = user || 'admin';
    document.getElementById('authScreen').hidden = true;
    document.getElementById('appShell').hidden = false;
    document.getElementById('accountName').textContent = currentUser;
    renderAll();
    await fetchApiStatus();
    await loadLiveData();
  }

  async function initAuth() {
    try {
      const headers = new Headers({ Accept: 'application/json' });
      const token = getFallbackToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const response = await fetch('/api/auth/session', { headers, credentials: 'include', cache: 'no-store' });
      if (!response.ok) {
        setFallbackToken('');
        showAuthScreen();
        return;
      }
      const data = await response.json();
      if (data.authenticated) await showApp(data.user);
      else showAuthScreen();
    } catch {
      showAuthScreen('Не удалось проверить авторизацию. Запускай приложение через Cloudflare Worker, а не как обычный HTML-файл.');
    }
  }

  async function login(event) {
    event.preventDefault();
    const username = document.getElementById('loginInput').value.trim();
    const password = document.getElementById('passwordInput').value;
    const button = document.getElementById('loginBtn');
    const error = document.getElementById('authError');
    error.hidden = true;
    button.disabled = true;
    button.textContent = 'Проверяю…';
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        cache: 'no-store',
        body: JSON.stringify({ username, password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Неверный логин или пароль');
      if (data.token) setFallbackToken(data.token);

      const verifyHeaders = new Headers({ Accept: 'application/json' });
      if (data.token) verifyHeaders.set('Authorization', `Bearer ${data.token}`);
      const verify = await fetch('/api/auth/session', { headers: verifyHeaders, credentials: 'include', cache: 'no-store' });
      if (!verify.ok) throw new Error('Вход принят, но сервер не смог сохранить сессию.');
      const verified = await verify.json().catch(() => ({}));
      await showApp(verified.user || data.user);
    } catch (err) {
      error.textContent = err.message || 'Не удалось войти';
      error.hidden = false;
      document.getElementById('passwordInput').select();
    } finally {
      button.disabled = false;
      button.textContent = 'Войти';
    }
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include', cache: 'no-store' }); } catch {}
    setFallbackToken('');
    showAuthScreen();
  }

  function loadState(){
    try {
      const raw = localStorage.getItem('marketing-os-state-v1');
      if (!raw) return structuredClone(demo);
      const parsed = JSON.parse(raw);
      return {...structuredClone(demo), ...parsed, tasks: parsed.tasks || structuredClone(demo.tasks)};
    } catch { return structuredClone(demo); }
  }
  function saveState(){ localStorage.setItem('marketing-os-state-v1', JSON.stringify(state)); }

  function periodData(arr, days, dateKey='date') {
    const from = new Date(today); from.setDate(from.getDate() - (days - 1)); from.setHours(0,0,0,0);
    return arr.filter(x => new Date(`${x[dateKey]}T12:00:00`) >= from);
  }
  function deltaValue(current, previous) { if (!previous) return current ? 100 : 0; return ((current - previous) / previous) * 100; }
  function comparePeriod(arr, days, key) {
    const sorted = [...arr].sort((a,b)=>a.date.localeCompare(b.date));
    const recent = sorted.slice(-days); const prev = sorted.slice(-(days*2), -days);
    return { current: sum(recent,key), previous: sum(prev,key), delta: deltaValue(sum(recent,key), sum(prev,key)) };
  }
  function compareAvg(arr, days, key) {
    const sorted = [...arr].sort((a,b)=>a.date.localeCompare(b.date));
    const recent = sorted.slice(-days); const prev = sorted.slice(-(days*2), -days);
    const c = avg(recent,key), p = avg(prev,key); return {current:c, previous:p, delta:deltaValue(c,p)};
  }
  function deltaBadge(v, inverse=false) {
    const val = Number(v || 0); const good = inverse ? val < 0 : val > 0;
    const cls = Math.abs(val) < .3 ? 'flat' : good ? 'up' : 'down';
    const sign = val > 0 ? '+' : '';
    return `<span class="delta ${cls}">${sign}${val.toFixed(1).replace('.',',')}%</span>`;
  }
  function statusPill(label, cls='good'){ return `<span class="status ${cls}">${escapeHtml(label)}</span>`; }

  function calcHealth() {
    const days = Number(document.getElementById('periodSelect').value || 30);
    const traffic = comparePeriod(state.site, Math.min(days, Math.floor(state.site.length/2)), 'visits');
    const ads = summarizeAds(); const seo = summarizeSeo(); const site = summarizeSite(days);
    let score = 78;
    score += clamp(traffic.delta, -20, 20) * .25;
    score += seo.avgPosition < 10 ? 4 : -4;
    score += ads.cpa < 2500 ? 5 : ads.cpa > 5000 ? -8 : 0;
    score += site.bounce < 20 ? 4 : site.bounce > 35 ? -5 : 0;
    return clamp(Math.round(score), 35, 98);
  }

  function summarizeSite(days=30){
    const d = periodData(state.site, days);
    return { visits:sum(d,'visits'), users:sum(d,'users'), conversions:sum(d,'conversions'), bounce:avg(d,'bounceRate'), depth:avg(d,'depth'), duration:avg(d,'duration') };
  }
  function summarizeSeo(){
    return {shows:sum(state.seo,'shows'), clicks:sum(state.seo,'clicks'), ctr:sum(state.seo,'shows') ? sum(state.seo,'clicks')/sum(state.seo,'shows')*100 : 0, avgPosition:avg(state.seo,'position'), growing:state.seo.filter(x=>x.delta>0).length, falling:state.seo.filter(x=>x.delta<0).length};
  }
  function summarizeAds(){
    const spend=sum(state.ads,'spend'), clicks=sum(state.ads,'clicks'), impressions=sum(state.ads,'impressions'), conversions=sum(state.ads,'conversions');
    return {spend,clicks,impressions,conversions,ctr:impressions?clicks/impressions*100:0,cpc:clicks?spend/clicks:0,cpa:conversions?spend/conversions:0};
  }
  function summarizeSocial(){
    const reach=sum(state.social,'reach'), reactions=sum(state.social,'reactions'); return {reach,reactions,er:reach?reactions/reach*100:0, posts:state.social.length};
  }
  function summarizeEmail(){
    const sent=sum(state.email,'sent'), opened=sum(state.email,'opened'), clicked=sum(state.email,'clicked'), unsub=sum(state.email,'unsub'), errors=sum(state.email,'errors');
    return {sent,opened,clicked,unsub,errors,openRate:sent?opened/sent*100:0,ctr:sent?clicked/sent*100:0,unsubRate:sent?unsub/sent*100:0};
  }

  function getIssues(){
    const issues=[]; const ads=summarizeAds(); const seo=summarizeSeo(); const site=summarizeSite(Number(document.getElementById('periodSelect').value||30)); const email=summarizeEmail();
    const badCampaign = [...state.ads].map(x=>({...x,cpa:x.conversions?x.spend/x.conversions:Infinity,ctr:x.impressions?x.clicks/x.impressions*100:0})).sort((a,b)=>b.cpa-a.cpa)[0];
    if (badCampaign && badCampaign.cpa > 4000) issues.push({level:'high',title:`Реклама: ${badCampaign.name}`,text:`CPA ${isFinite(badCampaign.cpa)?money.format(badCampaign.cpa):'без конверсий'}, CTR ${pct(badCampaign.ctr)}. Канал расходует бюджет значительно хуже остальных.`,action:'Остановить масштабирование и протестировать новый оффер/аудиторию.',view:'ads'});
    const seoDrop=[...state.seo].filter(x=>x.delta<0).sort((a,b)=>a.delta-b.delta)[0];
    if(seoDrop) issues.push({level:'high',title:`SEO: падает «${seoDrop.query}»`,text:`Средняя позиция ${seoDrop.position.toFixed(1)}, изменение ${seoDrop.delta.toFixed(1)}. При ${fmt.format(seoDrop.shows)} показах потеря позиции уже влияет на трафик.`,action:'Проверить страницу, сниппет, внутренние ссылки и конкурентов.',view:'seo'});
    const weakPage=[...state.pages].sort((a,b)=>b.bounce-a.bounce)[0];
    if(weakPage && weakPage.bounce>30) issues.push({level:'medium',title:`Сайт: высокий отказ на «${weakPage.title}»`,text:`Отказы ${pct(weakPage.bounce)}, глубина ${weakPage.depth.toFixed(1)}. Страница приводит трафик, но плохо удерживает его.`,action:'Проверить первый экран, интент страницы и скорость загрузки.',view:'site'});
    if(email.openRate<25 && email.sent>0) issues.push({level:'medium',title:'Email: открытия ниже рабочего ориентира',text:`Средний Open Rate ${pct(email.openRate)}. Это сигнал проверить тему, имя отправителя и качество базы.`,action:'Сделать A/B тест темы следующей рассылки.',view:'email'});
    const opp=state.seo.filter(x=>x.position>=5&&x.position<=15&&x.shows>1000).sort((a,b)=>b.shows-a.shows)[0];
    if(opp) issues.push({level:'low',title:`SEO-возможность: «${opp.query}»`,text:`${fmt.format(opp.shows)} показов, позиция ${opp.position.toFixed(1)}, CTR ${pct(opp.ctr)}. Запрос уже близко к первой пятёрке.`,action:'Приоритетно усилить страницу — это самый дешёвый рост.',view:'seo'});
    return issues;
  }

  function renderMetricGrid(id, items){
    document.getElementById(id).innerHTML = items.map(x=>`<article class="metric-card"><div class="metric-top"><span class="metric-title">${escapeHtml(x.title)}</span>${x.delta !== undefined ? deltaBadge(x.delta,x.inverse): (x.badge||'')}</div><div class="metric-value">${x.value}</div><div class="metric-note">${escapeHtml(x.note||'')}</div></article>`).join('');
  }

  function chart(id,type,data,options={}){
    if(!window.Chart) return;
    if(charts[id]) charts[id].destroy();
    const ctx=document.getElementById(id); if(!ctx) return;
    charts[id]=new Chart(ctx,{type,data,options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{backgroundColor:'#101828',padding:10,titleColor:'#fff',bodyColor:'#fff'}},scales:type==='doughnut'?{}:{x:{grid:{display:false},ticks:{color:'#98a2b3',maxTicksLimit:8}},y:{beginAtZero:true,grid:{color:'#eef0f3'},ticks:{color:'#98a2b3'}}},...options}});
  }

  function renderOverview(){
    const days=Number(document.getElementById('periodSelect').value||30); const sd=periodData(state.site,days); const health=calcHealth(); const site=summarizeSite(days); const ads=summarizeAds(); const seo=summarizeSeo(); const social=summarizeSocial();
    const trafficCmp=comparePeriod(state.site,Math.min(days,Math.floor(state.site.length/2)),'visits');
    document.getElementById('healthScore').textContent=health;
    document.getElementById('healthStatus').textContent=health>=82?'Маркетинг работает устойчиво':health>=65?'Система в норме, но есть точки риска':'Нужно вмешательство в несколько каналов';
    const issues=getIssues();
    document.getElementById('healthSummary').textContent=`${seo.growing} SEO-запросов растут, ${seo.falling} снижаются; рекламный CPA ${money.format(ads.cpa)}.`;
    if(issues[0]){document.getElementById('focusTitle').textContent=issues[0].title;document.getElementById('focusText').textContent=issues[0].action;document.querySelector('[data-jump]').dataset.jump=issues[0].view;}
    renderMetricGrid('overviewMetrics',[
      {title:'Визиты',value:fmt.format(site.visits),delta:trafficCmp.delta,note:`за ${days} дней`},
      {title:'Конверсии сайта',value:fmt.format(site.conversions),note:`CR ${site.visits?pct(site.conversions/site.visits*100):'0%'}`},
      {title:'Рекламные расходы',value:money.format(ads.spend),note:`CPA ${money.format(ads.cpa)}`},
      {title:'Охват соцсетей',value:fmt.format(social.reach),note:`ER ${pct(social.er)}`}
    ]);
    chart('overviewChart','line',{labels:sd.map(x=>ruDate(x.date)),datasets:[{label:'Визиты',data:sd.map(x=>x.visits),borderColor:'#4457ff',backgroundColor:'rgba(68,87,255,.08)',fill:true,tension:.32,pointRadius:0},{label:'Конверсии ×20',data:sd.map(x=>x.conversions*20),borderColor:'#12b76a',backgroundColor:'transparent',tension:.32,pointRadius:0}]});
    document.getElementById('issuesCount').textContent=`${issues.length} сигнал${issues.length===1?'':issues.length<5?'а':'ов'}`;
    document.getElementById('issueList').innerHTML=issues.map(issueHtml).join('');
    const channels=[
      {name:'Органический поиск',value:state.sources.find(x=>x.name==='Поиск')?.visits||0,delta:18,conv:14,cost:'0 ₽',score:['Сильный','good']},
      {name:'Яндекс Директ',value:state.sources.find(x=>x.name==='Директ')?.visits||0,delta:32,conv:ads.conversions,cost:money.format(ads.spend),score:[ads.cpa<3000?'Работает':'Дорого',ads.cpa<3000?'good':'warn']},
      {name:'VK',value:state.social.filter(x=>x.channel==='VK').reduce((a,x)=>a+x.reach,0),delta:-8,conv:state.ads.find(x=>x.name.includes('VK'))?.conversions||0,cost:money.format(state.ads.find(x=>x.name.includes('VK'))?.spend||0),score:['Требует изменений','bad']},
      {name:'Telegram',value:state.social.filter(x=>x.channel==='Telegram').reduce((a,x)=>a+x.reach,0),delta:14,conv:1,cost:'0 ₽',score:['Стабильно','good']}
    ];
    document.getElementById('channelTable').innerHTML=channels.map(x=>`<tr><td><strong>${escapeHtml(x.name)}</strong></td><td>${fmt.format(x.value)}</td><td>${deltaBadge(x.delta)}</td><td>${fmt.format(x.conv)}</td><td>${x.cost}</td><td>${statusPill(x.score[0],x.score[1])}</td></tr>`).join('');
  }

  function issueHtml(x){return `<div class="issue-item"><div class="issue-icon ${x.level}">${x.level==='high'?'!':x.level==='medium'?'↗':'+'}</div><div><div class="issue-title">${escapeHtml(x.title)}</div><div class="issue-text">${escapeHtml(x.text)}</div><div class="issue-action">${escapeHtml(x.action)}</div></div></div>`}

  function renderSite(){
    const days=Number(document.getElementById('periodSelect').value||30), d=periodData(state.site,days), s=summarizeSite(days), cmp=comparePeriod(state.site,Math.min(days,Math.floor(state.site.length/2)),'visits'), bounceCmp=compareAvg(state.site,Math.min(days,Math.floor(state.site.length/2)),'bounceRate');
    renderMetricGrid('siteMetrics',[
      {title:'Визиты',value:fmt.format(s.visits),delta:cmp.delta,note:`за ${days} дней`},{title:'Посетители',value:fmt.format(s.users),note:'уникальные'},
      {title:'Отказы',value:pct(s.bounce),delta:bounceCmp.delta,inverse:true,note:'чем ниже, тем лучше'},{title:'Средняя глубина',value:s.depth.toFixed(2).replace('.',','),note:`время ${Math.floor(s.duration/60)}:${String(Math.round(s.duration%60)).padStart(2,'0')}`}
    ]);
    chart('siteChart','line',{labels:d.map(x=>ruDate(x.date)),datasets:[{data:d.map(x=>x.visits),borderColor:'#4457ff',backgroundColor:'rgba(68,87,255,.08)',fill:true,tension:.3,pointRadius:0}]});
    chart('sourceChart','doughnut',{labels:state.sources.map(x=>x.name),datasets:[{data:state.sources.map(x=>x.visits),backgroundColor:['#4457ff','#12b76a','#f79009','#6172f3','#2e90fa','#98a2b3'],borderWidth:0}]},{cutout:'68%',plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,usePointStyle:true}}}});
    document.getElementById('pagesTable').innerHTML=[...state.pages].sort((a,b)=>b.visits-a.visits).map(x=>`<tr><td><strong>${escapeHtml(x.title)}</strong><div class="muted">${escapeHtml(x.page)}</div></td><td>${fmt.format(x.visits)}</td><td class="${x.bounce>30?'num-bad':x.bounce<15?'num-good':''}">${pct(x.bounce)}</td><td>${x.depth.toFixed(1)}</td><td>${x.conversions}</td><td>${x.bounce>30?statusPill('Проверить','bad'):x.conversions>2?statusPill('Сильная','good'):statusPill('Норма','info')}</td></tr>`).join('');
  }

  function renderSeo(){
    const s=summarizeSeo(); renderMetricGrid('seoMetrics',[
      {title:'Показы',value:fmt.format(s.shows),note:'по отслеживаемым запросам'},{title:'Клики',value:fmt.format(s.clicks),note:`CTR ${pct(s.ctr)}`},{title:'Средняя позиция',value:s.avgPosition.toFixed(1).replace('.',','),note:'по выборке'},{title:'Динамика',value:`+${s.growing} / −${s.falling}`,note:'растут / падают'}
    ]);
    const sorted=[...state.seo].sort((a,b)=>b.shows-a.shows); chart('seoChart','bar',{labels:sorted.map(x=>x.query.length>24?x.query.slice(0,22)+'…':x.query),datasets:[{label:'Показы',data:sorted.map(x=>x.shows),backgroundColor:'#d6dcff',borderRadius:8},{label:'Клики',data:sorted.map(x=>x.clicks*8),backgroundColor:'#4457ff',borderRadius:8}]},{plugins:{legend:{display:true,position:'bottom'}},scales:{x:{grid:{display:false},ticks:{color:'#98a2b3',maxRotation:0,minRotation:0}},y:{grid:{color:'#eef0f3'},ticks:{color:'#98a2b3'}}}});
    const opp=state.seo.filter(x=>x.position>=5&&x.position<=15&&x.shows>700).sort((a,b)=>(b.shows*(1-b.ctr/100))-(a.shows*(1-a.ctr/100))).slice(0,4).map(x=>({level:x.position<10?'low':'medium',title:x.query,text:`${fmt.format(x.shows)} показов · позиция ${x.position.toFixed(1)} · CTR ${pct(x.ctr)}`,action:x.ctr<2?'Сначала улучшить сниппет и соответствие интенту.':'Усилить страницу внутренними ссылками и контентом.'}));
    document.getElementById('seoOpportunities').innerHTML=opp.map(issueHtml).join('');
    renderSeoTable();
  }
  function seoPriority(x){const score=(x.shows/500)+(15-x.position)+(3-x.ctr);return score>15?['Высокий','bad']:score>9?['Средний','warn']:['Низкий','info'];}
  function renderSeoTable(){
    const q=(document.getElementById('seoSearch')?.value||'').trim().toLowerCase();
    document.getElementById('seoTable').innerHTML=[...state.seo].filter(x=>x.query.toLowerCase().includes(q)).sort((a,b)=>b.shows-a.shows).map(x=>{const pr=seoPriority(x);return `<tr><td><strong>${escapeHtml(x.query)}</strong></td><td>${fmt.format(x.shows)}</td><td>${fmt.format(x.clicks)}</td><td>${pct(x.ctr)}</td><td>${x.position.toFixed(1)}</td><td class="${x.delta>0?'num-good':'num-bad'}">${x.delta>0?'+':''}${x.delta.toFixed(1)}</td><td>${statusPill(pr[0],pr[1])}</td></tr>`}).join('');
  }

  function renderAds(){
    const a=summarizeAds(); renderMetricGrid('adsMetrics',[
      {title:'Расход',value:money.format(a.spend),note:'все кампании'},{title:'Клики',value:fmt.format(a.clicks),note:`CTR ${pct(a.ctr)}`},{title:'CPC',value:money.format(a.cpc),note:'средняя цена клика'},{title:'Конверсии',value:fmt.format(a.conversions),note:`CPA ${money.format(a.cpa)}`}
    ]);
    const d=periodData(state.adsDaily,Math.min(30,Number(document.getElementById('periodSelect').value||30))); chart('adsChart','line',{labels:d.map(x=>ruDate(x.date)),datasets:[{label:'Расход',data:d.map(x=>x.spend),borderColor:'#f79009',backgroundColor:'rgba(247,144,9,.09)',fill:true,tension:.3,pointRadius:0},{label:'Конверсии × 400',data:d.map(x=>x.conversions*400),borderColor:'#12b76a',backgroundColor:'transparent',tension:.3,pointRadius:0}]},{plugins:{legend:{display:true,position:'bottom'}}});
    const diagnostics=[...state.ads].map(x=>({...x,ctr:x.impressions?x.clicks/x.impressions*100:0,cpa:x.conversions?x.spend/x.conversions:Infinity})).sort((a,b)=>b.cpa-a.cpa).slice(0,3).map(x=>({level:x.cpa>5000?'high':x.cpa>3000?'medium':'low',title:x.name,text:`CTR ${pct(x.ctr)} · расход ${money.format(x.spend)} · ${isFinite(x.cpa)?`CPA ${money.format(x.cpa)}`:'конверсий нет'}`,action:x.cpa>5000?'Не масштабировать. Проверить оффер, аудиторию и посадочную.':x.ctr<1?'Сначала поднять кликабельность креатива.':'Кампания выглядит рабочей — оптимизировать постепенно.'})); document.getElementById('adsIssues').innerHTML=diagnostics.map(issueHtml).join('');
    document.getElementById('adsTable').innerHTML=state.ads.map(x=>{const ctr=x.impressions?x.clicks/x.impressions*100:0,cpc=x.clicks?x.spend/x.clicks:0,cpa=x.conversions?x.spend/x.conversions:Infinity;const st=cpa<2500?['Сильная','good']:cpa<4500?['Наблюдать','warn']:['Проблема','bad'];return `<tr><td><strong>${escapeHtml(x.name)}</strong></td><td>${fmt.format(x.impressions)}</td><td>${fmt.format(x.clicks)}</td><td>${pct(ctr)}</td><td>${money.format(x.spend)}</td><td>${money.format(cpc)}</td><td>${x.conversions}</td><td>${isFinite(cpa)?money.format(cpa):'—'}</td><td>${statusPill(st[0],st[1])}</td></tr>`}).join('');
  }

  function renderSocial(){
    const s=summarizeSocial(); const channels=[...new Set(state.social.map(x=>x.channel))]; renderMetricGrid('socialMetrics',[
      {title:'Охват',value:fmt.format(s.reach),note:'сумма по публикациям'},{title:'Реакции',value:fmt.format(s.reactions),note:`ER ${pct(s.er)}`},{title:'Публикации',value:fmt.format(s.posts),note:'в выборке'},{title:'Каналы',value:fmt.format(channels.length),note:channels.join(' · ')}
    ]);
    chart('socialChart','bar',{labels:channels,datasets:[{data:channels.map(c=>sum(state.social.filter(x=>x.channel===c),'reach')),backgroundColor:['#4457ff','#12b76a','#f79009','#2e90fa','#98a2b3'],borderRadius:9}]});
    const top=[...state.social].map(x=>({...x,er:x.reach?x.reactions/x.reach*100:0})).sort((a,b)=>b.er-a.er).slice(0,3).map(x=>({level:'low',title:x.title,text:`${x.channel}: охват ${fmt.format(x.reach)}, ER ${pct(x.er)}.`,action:x.er>7?'Формат даёт сильную вовлечённость — стоит сделать серию.':'Сохранить тему, но усилить подачу и CTA.'})); document.getElementById('contentInsights').innerHTML=top.map(issueHtml).join('');
    document.getElementById('socialTable').innerHTML=[...state.social].sort((a,b)=>b.date.localeCompare(a.date)).map(x=>{const er=x.reach?x.reactions/x.reach*100:0;return `<tr><td>${statusPill(x.channel,'info')}</td><td><strong>${escapeHtml(x.title)}</strong></td><td>${ruDate(x.date)}</td><td>${fmt.format(x.reach)}</td><td>${fmt.format(x.reactions)}</td><td>${pct(er)}</td><td>${er>7?statusPill('Сильный','good'):er>3?statusPill('Норма','info'):statusPill('Слабый','warn')}</td></tr>`}).join('');
  }

  function renderEmail(){
    const e=summarizeEmail(); renderMetricGrid('emailMetrics',[
      {title:'Отправлено',value:fmt.format(e.sent),note:'по доступным рассылкам'},{title:'Open Rate',value:pct(e.openRate),note:'открытия / отправки'},{title:'CTR',value:pct(e.ctr),note:'клики / отправки'},{title:'Отписки',value:pct(e.unsubRate,2),note:`${fmt.format(e.unsub)} человек`}
    ]);
    const campaigns=[...state.email].sort((a,b)=>a.date.localeCompare(b.date)); chart('emailChart','line',{labels:campaigns.map(x=>ruDate(x.date)),datasets:[{label:'Open rate',data:campaigns.map(x=>x.sent?x.opened/x.sent*100:0),borderColor:'#4457ff',tension:.3},{label:'CTR',data:campaigns.map(x=>x.sent?x.clicked/x.sent*100:0),borderColor:'#12b76a',tension:.3}]},{plugins:{legend:{display:true,position:'bottom'}}});
    const issues=[]; if(e.openRate<25)issues.push({level:'medium',title:'Открываемость можно поднять',text:`Среднее значение ${pct(e.openRate)}.`,action:'Тестировать тему, прехедер и сегментацию базы.'}); if(e.unsubRate>.5)issues.push({level:'high',title:'Слишком много отписок',text:`Отписки ${pct(e.unsubRate,2)}.`,action:'Проверить частоту отправок и релевантность сегмента.'}); issues.push({level:'low',title:'Лучший сценарий рассылки',text:'Сравнивай тему письма, открываемость и клики вместе — высокий Open Rate без кликов не означает хороший результат.',action:'В отчёте ориентироваться на переходы и бизнес-конверсии.'}); document.getElementById('emailIssues').innerHTML=issues.map(issueHtml).join('');
    document.getElementById('emailTable').innerHTML=[...state.email].sort((a,b)=>b.date.localeCompare(a.date)).map(x=>{const or=x.sent?x.opened/x.sent*100:0,ctr=x.sent?x.clicked/x.sent*100:0;return `<tr><td><strong>${escapeHtml(x.name)}</strong><div class="muted">${ruDate(x.date)}</div></td><td>${fmt.format(x.sent)}</td><td>${pct(or)}</td><td>${pct(ctr)}</td><td>${x.unsub}</td><td>${x.errors}</td><td>${or>28&&ctr>4?statusPill('Сильная','good'):or<22?statusPill('Слабая','warn'):statusPill('Норма','info')}</td></tr>`}).join('');
  }

  function renderTasks(){
    document.getElementById('taskList').innerHTML=state.tasks.sort((a,b)=>({high:0,medium:1,low:2}[a.priority]-({high:0,medium:1,low:2}[b.priority]))).map(x=>`<div class="task-item ${x.done?'done':''}"><input class="task-check" type="checkbox" data-task="${escapeHtml(x.id)}" ${x.done?'checked':''}/><div><div class="task-title">${escapeHtml(x.title)}</div><div class="task-meta">${escapeHtml(x.source||'Своя задача')}</div></div><span class="priority ${x.priority}">${x.priority==='high'?'Высокий':x.priority==='medium'?'Средний':'Низкий'}</span></div>`).join('');
    const top=state.tasks.filter(x=>!x.done).sort((a,b)=>({high:0,medium:1,low:2}[a.priority]-{high:0,medium:1,low:2}[b.priority])).slice(0,4); document.getElementById('focusSteps').innerHTML=top.map(x=>`<li>${escapeHtml(x.title)}</li>`).join('');
    document.querySelectorAll('[data-task]').forEach(el=>el.addEventListener('change',e=>{const t=state.tasks.find(x=>x.id===e.target.dataset.task);if(t){t.done=e.target.checked;saveState();renderTasks();}}));
  }

  function renderReports(){
    const s=summarizeSite(Number(document.getElementById('reportPeriod')?.value||30)), seo=summarizeSeo(), ads=summarizeAds(), social=summarizeSocial(), email=summarizeEmail();
    const rows=[['Здоровье маркетинга',`${calcHealth()}/100`],['Визиты',fmt.format(s.visits)],['SEO-показы',fmt.format(seo.shows)],['Рекламные расходы',money.format(ads.spend)],['Рекламный CPA',money.format(ads.cpa)],['Охват соцсетей',fmt.format(social.reach)],['Email Open Rate',pct(email.openRate)],['Активные задачи',state.tasks.filter(x=>!x.done).length]];
    document.getElementById('reportPreview').innerHTML=rows.map(r=>`<div class="preview-row"><span>${r[0]}</span><strong>${r[1]}</strong></div>`).join('');
  }

  const integrations=[
    {id:'metrika',name:'Яндекс Метрика',desc:'Визиты, посетители, отказы, глубина, источники и страницы.',server:true},
    {id:'webmaster',name:'Яндекс Вебмастер',desc:'Поисковые запросы, показы, клики, позиции и SEO-сигналы.',server:true},
    {id:'direct',name:'Яндекс Директ',desc:'Расходы, показы, клики, CTR, конверсии и CPA.',server:true},
    {id:'vk',name:'VK / VK Реклама',desc:'Пока предусмотрен импорт отчётов; API-адаптер можно подключить отдельно.',server:false},
    {id:'telegram',name:'Telegram',desc:'Импорт статистики публикаций или подключение внешнего аналитического сервиса.',server:false},
    {id:'email',name:'UniSender / Email',desc:'Отправки, открытия, клики, ошибки и отписки через импорт/API.',server:false},
    {id:'excel',name:'Excel / CSV',desc:'Универсальный импорт для любых данных, которых нет в API.',server:false}
  ];

  function renderIntegrations(){
    document.getElementById('integrationGrid').innerHTML=integrations.map(x=>{const st=apiStatus.integrations?.[x.id];const connected=st?.connected;const label=connected?'Подключено':x.server?'Не настроено':'Через импорт';const cls=connected?'good':x.server?'warn':'info';return `<article class="integration-card"><div class="integration-top"><div class="integration-name">${escapeHtml(x.name)}</div>${statusPill(label,cls)}</div><div class="integration-desc">${escapeHtml(x.desc)}</div><div class="integration-meta">${connected&&st.lastSync?`Последняя синхронизация: ${escapeHtml(st.lastSync)}`:x.server?'Нужны серверные secrets':'Можно использовать уже сейчас'}</div><div class="integration-actions">${x.server?`<button class="secondary-btn sync-one" data-source="${x.id}" ${connected?'':'disabled'}>Синхронизировать</button>`:`<button class="secondary-btn import-one" data-source="${x.id==='excel'?'site':x.id}">Импортировать</button>`}</div></article>`}).join('');
    document.querySelectorAll('.sync-one').forEach(b=>b.addEventListener('click',()=>syncSource(b.dataset.source)));
    document.querySelectorAll('.import-one').forEach(b=>b.addEventListener('click',()=>{document.getElementById('importSource').value=['telegram','vk'].includes(b.dataset.source)?'social':b.dataset.source;document.getElementById('fileInput').click();}));
  }

  function renderAll(){renderOverview();renderSite();renderSeo();renderAds();renderSocial();renderEmail();renderTasks();renderReports();renderIntegrations();}

  async function fetchApiStatus(){
    try{const r=await apiFetch('/api/status',{headers:{Accept:'application/json'}});if(!r.ok)throw new Error('no api');apiStatus=await r.json();document.getElementById('syncDot').className='dot '+(apiStatus.mode==='live'?'live':'warn');document.getElementById('syncText').textContent=apiStatus.mode==='live'?'Сервер подключён':'Демо + локальные данные';}
    catch{apiStatus={mode:'demo',integrations:{}};document.getElementById('syncDot').className='dot warn';document.getElementById('syncText').textContent='Демо + локальные данные';}
    renderIntegrations();
  }

  async function syncSource(source){
    showAlert(`Синхронизирую ${source}…`,'');
    try{const r=await apiFetch(`/api/sync/${source}`,{method:'POST'});const out=await r.json();if(!r.ok)throw new Error(out.error||'Ошибка синхронизации');showAlert(out.message||'Данные обновлены','success');await loadLiveData();await fetchApiStatus();}
    catch(e){showAlert(e.message||'Не удалось синхронизировать','error');}
  }

  async function syncAll(){
    const connected=Object.entries(apiStatus.integrations||{}).filter(([,v])=>v.connected).map(([k])=>k);
    if(!connected.length){showAlert('Серверные интеграции ещё не настроены. Сейчас приложение работает на локальных и импортированных данных.','');return;}
    for(const source of connected.filter(x=>['metrika','webmaster','direct'].includes(x))) await syncSource(source);
  }

  async function loadLiveData(){
    try{const r=await apiFetch('/api/dashboard');if(!r.ok)return;const live=await r.json();
      if(live.site?.length) state.site=live.site;
      if(live.sources?.length) state.sources=live.sources;
      if(live.pages?.length) state.pages=live.pages;
      if(live.seo?.length) state.seo=live.seo;
      if(live.ads?.length) state.ads=live.ads;
      if(live.adsDaily?.length) state.adsDaily=live.adsDaily;
      saveState();renderAll();
    }catch{}
  }

  function showAlert(text,type=''){const el=document.getElementById('globalAlert');el.textContent=text;el.className=`alert ${type}`;el.hidden=false;clearTimeout(showAlert.timer);showAlert.timer=setTimeout(()=>el.hidden=true,5000);}

  function navigate(view){
    document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===view));document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
    const copy={overview:['Маркетинговый обзор','Где всё растёт, где течёт и что делать дальше.'],site:['Сайт','Трафик, поведение и качество посадочных страниц.'],seo:['SEO','Запросы, позиции, CTR и точки роста.'],ads:['Реклама','Расходы, конверсии и эффективность кампаний.'],social:['Соцсети','Охват, вовлечённость и сильные форматы контента.'],email:['Email','Рассылки, открытия, клики и качество базы.'],tasks:['Задачи','Автоматический список действий по найденным проблемам.'],reports:['Отчёты','Собери понятный отчёт руководителю в один клик.'],integrations:['Интеграции','API, Excel и ручные источники в одном месте.']}[view];
    document.getElementById('pageTitle').textContent=copy[0];document.getElementById('pageSubtitle').textContent=copy[1];document.getElementById('sidebar').classList.remove('open');
    if(view==='reports')renderReports();
  }

  function normalizeRow(row){
    const o={}; Object.entries(row).forEach(([k,v])=>{const key=String(k).trim().toLowerCase().replace(/ё/g,'е');o[key]=v;});return o;
  }
  function val(row, keys, fallback=0){for(const k of keys){if(row[k]!==undefined&&row[k]!==null&&row[k]!==''){const raw=typeof row[k]==='string'?row[k].replace(/\s/g,'').replace(',','.').replace('%',''):row[k];const num=Number(raw);return Number.isFinite(num)?num:row[k];}}return fallback;}
  function textVal(row,keys,fallback=''){for(const k of keys){if(row[k]!==undefined&&row[k]!==null&&row[k]!=='')return String(row[k]);}return fallback;}
  function dateVal(row){let d=textVal(row,['дата','date','day','день']);if(!d)return iso(today);if(typeof d==='number'&&window.XLSX){const p=XLSX.SSF.parse_date_code(d);if(p)return `${p.y}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')}`;}const parsed=new Date(d);return Number.isNaN(parsed.getTime())?iso(today):iso(parsed);}

  async function importFile(file){
    const source=document.getElementById('importSource').value,mode=document.getElementById('importMode').value;
    let rows=[]; const name=file.name.toLowerCase();
    if(name.endsWith('.json')){rows=JSON.parse(await file.text());if(!Array.isArray(rows))rows=rows.data||rows.rows||[];}
    else if(name.endsWith('.csv')){if(window.XLSX){const wb=XLSX.read(await file.arrayBuffer(),{type:'array'});rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});}else{throw new Error('Модуль импорта CSV не загрузился.');}}
    else {if(!window.XLSX)throw new Error('Модуль Excel не загрузился.');const wb=XLSX.read(await file.arrayBuffer(),{type:'array'});rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});}
    rows=rows.map(normalizeRow); if(!rows.length) throw new Error('В файле не нашлось строк данных.');
    let parsed=[];
    if(source==='site') parsed=rows.map(r=>({date:dateVal(r),visits:val(r,['визиты','visits','сеансы','sessions']),users:val(r,['посетители','users','пользователи']),pageviews:val(r,['просмотры','pageviews','views']),bounceRate:val(r,['отказы','bouncerate','bounce rate','bounce']),depth:val(r,['глубина','depth','pages/session']),duration:val(r,['время','duration','avg duration']),conversions:val(r,['конверсии','conversions','цели','goals'])})).filter(x=>x.visits||x.users||x.pageviews||x.conversions);
    if(source==='seo') parsed=rows.map(r=>({query:textVal(r,['запрос','query','поисковый запрос','search query']),shows:val(r,['показы','shows','impressions']),clicks:val(r,['клики','clicks']),ctr:val(r,['ctr','ctr %','кликабельность']),position:val(r,['позиция','position','avg position']),delta:val(r,['изменение позиции','delta','динамика','change'])})).filter(x=>x.query);
    if(source==='ads') parsed=rows.map(r=>({name:textVal(r,['кампания','campaign','campaign name','название'],'Импортированная кампания'),impressions:val(r,['показы','impressions']),clicks:val(r,['клики','clicks']),spend:val(r,['расход','cost','spend','затраты']),conversions:val(r,['конверсии','conversions','goals'])})).filter(x=>x.impressions||x.clicks||x.spend||x.conversions);
    if(source==='social') parsed=rows.map(r=>({channel:textVal(r,['канал','channel','соцсеть','platform'],'Импорт'),title:textVal(r,['публикация','title','пост','post','материал'],'Публикация'),date:dateVal(r),reach:val(r,['охват','reach','просмотры','views','impressions']),reactions:val(r,['реакции','reactions','лайки','likes','engagement'])})).filter(x=>x.reach||x.reactions);
    if(source==='email') parsed=rows.map(r=>({name:textVal(r,['рассылка','name','campaign','тема'],'Рассылка'),date:dateVal(r),sent:val(r,['отправлено','sent','delivered']),opened:val(r,['открытия','opened','opens']),clicked:val(r,['клики','clicked','clicks']),unsub:val(r,['отписки','unsub','unsubscribes']),errors:val(r,['ошибки','errors','bounces'])})).filter(x=>x.sent||x.opened||x.clicked);
    if(!parsed.length) throw new Error('Не удалось сопоставить колонки. Проверь названия полей или выбери другой источник.');
    if(mode==='replace') state[source]=parsed; else state[source]=[...(state[source]||[]),...parsed];
    saveState(); renderAll(); document.getElementById('importLog').innerHTML=`<strong>${escapeHtml(file.name)}</strong>: импортировано ${parsed.length} строк в раздел «${escapeHtml(source)}» (${mode==='replace'?'замена':'добавление'}).`;
    try{await apiFetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,rows:parsed,mode})});}catch{}
    showAlert(`Импортировано ${parsed.length} строк из ${file.name}`,'success');
  }

  function reportData(days){return {generatedAt:new Date().toISOString(),periodDays:days,health:calcHealth(),site:summarizeSite(days),seo:summarizeSeo(),ads:summarizeAds(),social:summarizeSocial(),email:summarizeEmail(),issues:getIssues(),tasks:state.tasks.filter(x=>!x.done),seoQueries:state.seo,adsCampaigns:state.ads,socialPosts:state.social};}
  function selectedSections(){return [...document.querySelectorAll('.reportCheck:checked')].map(x=>x.value);}
  function buildReportHtml(){
    const days=Number(document.getElementById('reportPeriod').value||30), data=reportData(days), selected=selectedSections(), title=escapeHtml(document.getElementById('reportName').value||'Маркетинговый отчёт');
    const kpi=(label,val)=>`<div class="pdf-kpi"><span>${escapeHtml(label)}</span><strong>${val}</strong></div>`;
    let h=`<div class="pdf-report"><h1>${title}</h1><div class="report-date">Период: последние ${days} дней · сформировано ${new Date().toLocaleString('ru-RU')}</div>`;
    if(selected.includes('overview'))h+=`<h2>Общая сводка</h2><div class="pdf-kpis">${kpi('CS Marketing Health',`${data.health}/100`)}${kpi('Визиты',fmt.format(data.site.visits))}${kpi('Конверсии',fmt.format(data.site.conversions))}${kpi('SEO-показы',fmt.format(data.seo.shows))}${kpi('Рекламный CPA',money.format(data.ads.cpa))}${kpi('Охват соцсетей',fmt.format(data.social.reach))}</div>`;
    if(selected.includes('site'))h+=`<h2>Сайт</h2><p>Визиты: <strong>${fmt.format(data.site.visits)}</strong> · посетители: <strong>${fmt.format(data.site.users)}</strong> · отказы: <strong>${pct(data.site.bounce)}</strong> · глубина: <strong>${data.site.depth.toFixed(2)}</strong>.</p>`;
    if(selected.includes('seo'))h+=`<h2>SEO</h2><p>Показы: <strong>${fmt.format(data.seo.shows)}</strong> · клики: <strong>${fmt.format(data.seo.clicks)}</strong> · CTR: <strong>${pct(data.seo.ctr)}</strong> · средняя позиция: <strong>${data.seo.avgPosition.toFixed(1)}</strong>.</p><table><thead><tr><th>Запрос</th><th>Показы</th><th>Клики</th><th>CTR</th><th>Позиция</th></tr></thead><tbody>${state.seo.slice(0,12).map(x=>`<tr><td>${escapeHtml(x.query)}</td><td>${fmt.format(x.shows)}</td><td>${fmt.format(x.clicks)}</td><td>${pct(x.ctr)}</td><td>${x.position.toFixed(1)}</td></tr>`).join('')}</tbody></table>`;
    if(selected.includes('ads'))h+=`<h2>Реклама</h2><p>Расход: <strong>${money.format(data.ads.spend)}</strong> · клики: <strong>${fmt.format(data.ads.clicks)}</strong> · конверсии: <strong>${fmt.format(data.ads.conversions)}</strong> · CPA: <strong>${money.format(data.ads.cpa)}</strong>.</p><table><thead><tr><th>Кампания</th><th>Расход</th><th>Клики</th><th>Конверсии</th><th>CPA</th></tr></thead><tbody>${state.ads.map(x=>`<tr><td>${escapeHtml(x.name)}</td><td>${money.format(x.spend)}</td><td>${fmt.format(x.clicks)}</td><td>${x.conversions}</td><td>${x.conversions?money.format(x.spend/x.conversions):'—'}</td></tr>`).join('')}</tbody></table>`;
    if(selected.includes('social'))h+=`<h2>Соцсети</h2><p>Охват: <strong>${fmt.format(data.social.reach)}</strong> · реакции: <strong>${fmt.format(data.social.reactions)}</strong> · ER: <strong>${pct(data.social.er)}</strong>.</p>`;
    if(selected.includes('email'))h+=`<h2>Email</h2><p>Отправлено: <strong>${fmt.format(data.email.sent)}</strong> · Open Rate: <strong>${pct(data.email.openRate)}</strong> · CTR: <strong>${pct(data.email.ctr)}</strong> · отписки: <strong>${pct(data.email.unsubRate,2)}</strong>.</p>`;
    if(selected.includes('recommendations'))h+=`<h2>Проблемы и рекомендации</h2>${data.issues.map(x=>`<div class="pdf-reco"><strong>${escapeHtml(x.title)}</strong><span>${escapeHtml(x.text)} ${escapeHtml(x.action)}</span></div>`).join('')}<h2>План действий</h2><ol>${data.tasks.slice(0,8).map(x=>`<li>${escapeHtml(x.title)}</li>`).join('')}</ol>`;
    return h+'</div>';
  }
  async function downloadPdf(){const box=document.getElementById('reportCanvas');box.innerHTML=buildReportHtml();if(window.html2pdf){await html2pdf().set({margin:[9,9,9,9],filename:`marketing-report-${iso(today)}.pdf`,image:{type:'jpeg',quality:.96},html2canvas:{scale:2,useCORS:true},jsPDF:{unit:'mm',format:'a4',orientation:'portrait'},pagebreak:{mode:['css','legacy']}}).from(box.firstElementChild).save();}else{window.print();}}
  function downloadBlob(content,name,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);}
  function downloadJson(){const days=Number(document.getElementById('reportPeriod').value||30);downloadBlob(JSON.stringify(reportData(days),null,2),`marketing-data-${iso(today)}.json`,'application/json');}
  function downloadCsv(){const rows=[['section','metric','value'],['site','visits',summarizeSite(30).visits],['site','users',summarizeSite(30).users],['site','conversions',summarizeSite(30).conversions],['seo','shows',summarizeSeo().shows],['seo','clicks',summarizeSeo().clicks],['ads','spend',summarizeAds().spend],['ads','conversions',summarizeAds().conversions],['social','reach',summarizeSocial().reach],['email','openRate',summarizeEmail().openRate]];downloadBlob('\uFEFF'+rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(';')).join('\n'),`marketing-summary-${iso(today)}.csv`,'text/csv;charset=utf-8');}

  document.getElementById('loginForm').addEventListener('submit', login);
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
  document.querySelectorAll('[data-jump]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.jump)));
  document.getElementById('mobileMenuBtn').addEventListener('click',()=>document.getElementById('sidebar').classList.toggle('open'));
  document.getElementById('periodSelect').addEventListener('change',renderAll);
  document.getElementById('seoSearch').addEventListener('input',renderSeoTable);
  document.getElementById('syncBtn').addEventListener('click',syncAll);
  document.getElementById('quickReportBtn').addEventListener('click',downloadPdf);
  document.getElementById('generateReportBtn').addEventListener('click',downloadPdf);
  document.getElementById('downloadJsonBtn').addEventListener('click',downloadJson);
  document.getElementById('downloadCsvBtn').addEventListener('click',downloadCsv);
  document.getElementById('reportPeriod').addEventListener('change',renderReports);
  document.querySelectorAll('.reportCheck').forEach(x=>x.addEventListener('change',renderReports));
  document.getElementById('reportName').addEventListener('input',renderReports);
  document.getElementById('importBtn').addEventListener('click',()=>document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change',async(e)=>{const f=e.target.files?.[0];if(!f)return;try{await importFile(f);}catch(err){showAlert(err.message||'Ошибка импорта','error');}e.target.value='';});
  document.getElementById('resetDemoBtn').addEventListener('click',()=>{state=structuredClone(demo);saveState();renderAll();showAlert('Демо-данные восстановлены.','success');});
  document.getElementById('addTaskBtn').addEventListener('click',()=>document.getElementById('taskDialog').showModal());
  document.getElementById('taskForm').addEventListener('submit',(e)=>{e.preventDefault();const title=document.getElementById('taskTitleInput').value.trim();if(!title)return;state.tasks.push({id:`u${Date.now()}`,title,priority:document.getElementById('taskPriorityInput').value,source:'Своя задача',done:false});saveState();document.getElementById('taskTitleInput').value='';document.getElementById('taskDialog').close();renderTasks();});

  initAuth();
})();
