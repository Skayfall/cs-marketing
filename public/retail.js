// CS Marketing v2.9: retail Excel import + reporting. Client file parsing; D1 stores normalized rows.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n = v => Number(v) || 0;
  const price = v => new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:0}).format(n(v));
  const count = v => new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n(v));
  const LABELS = {
    date:'Дата продажи *', product:'Название товара', sku:'Артикул / SKU', orderId:'Номер заказа',
    quantity:'Количество', revenue:'Сумма продажи *', unitPrice:'Цена за единицу (вместо суммы)',
    operation:'Операция / статус (для возвратов)', commission:'Комиссия, ₽', logistics:'Логистика, ₽', cost:'Себестоимость строки, ₽'
  };
  const MATCHERS = {
    date:[/дата.*(прода|заказ|реализ|отгруз|операц)/i,/^(дата|date|sales date)$/i],
    product:[/^(наименование товара|название товара|товар|номенклатура|product|name)$/i,/наименование.*товар/i],
    sku:[/артикул.*(поставщика|товара)?/i,/^(sku|код товара|код номенклатуры)$/i],
    orderId:[/номер.*заказ/i,/^(заказ|order id|id заказа)$/i],
    quantity:[/^(количество|кол-во|количество проданных|quantity|qty|шт\.?)$/i,/количество.*(шт|прод|товар)/i],
    revenue:[/^(выручка|сумма продаж|сумма продажи|сумма реализации|сумма заказа|итого продаж|revenue|sales amount)$/i,/сумма.*(прода|реализ)/i,/стоимость.*(прода|реализ)/i],
    unitPrice:[/^(цена продажи|цена за единицу|цена за шт|unit price|цена товара)$/i],
    operation:[/^(операция|тип операции|статус|вид операции|operation)$/i],
    commission:[/^(комиссия|комиссия маркетплейса|вознаграждение площадки)$/i,/комиссия.*(площад|маркетплейс)/i],
    logistics:[/^(логистика|доставка|стоимость доставки|транспортные расходы)$/i,/логистическ.*расход/i],
    cost:[/^(себестоимость|себестоимость строки|закупочная стоимость)$/i]
  };
  let data={imports:[],daily:[],products:[],orders:{},coverage:{}};
  let book=null, sheet=null, selectedFile=null, sha=null, rows=[], headers=[], headerIndex=0, mapping={};
  let importing=false, initDone=false, chart=null, siteSources=[], siteUtm=[];
  let fromDate='',toDate='';
  const norm=s=>String(s||'').toLowerCase().replace(/[\s\u00a0_–—-]+/g,' ').replace(/[:.,()]+/g,'').trim();
  function asCell(value){
    if(value==null)return '';
    if(value instanceof Date)return value;
    if(typeof value==='object'){
      if(Object.hasOwn(value,'result'))return asCell(value.result);
      if(Array.isArray(value.richText))return value.richText.map(t=>t.text||'').join('');
      if(Object.hasOwn(value,'text'))return String(value.text||'');
      if(Object.hasOwn(value,'hyperlink'))return String(value.text||'');
      return '';
    }
    return value;
  }
  function setUpload(text,style=''){
    const x=$('retailUploadState');if(!x)return;
    x.textContent=text;x.className='retail-upload-state '+style;
  }
  async function req(path,method='GET',body){
    const r=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,
      credentials:'include',cache:'no-store',signal:AbortSignal.timeout(method==='GET'?25000:45000)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||'HTTP '+r.status);
    return d;
  }
  function numeric(value){
    if(typeof value==='number')return Number.isFinite(value)?value:0;
    if(value instanceof Date)return 0;
    let s=String(value??'').trim().replace(/[\s\u00a0₽р]/g,'').replace(/руб(\.|лей)?/gi,'');
    if(!s)return 0;
    const negative=/^\(.*\)$/.test(s);s=s.replace(/[()]/g,'').replace(/[^\d.,+\-]/g,'');
    if(s.includes(',')&&s.includes('.')){
      if(s.lastIndexOf(',')>s.lastIndexOf('.'))s=s.replace(/\./g,'').replace(',','.');
      else s=s.replace(/,/g,'');
    }else if(s.includes(','))s=s.replace(',','.');
    const x=Number(s);return Number.isFinite(x)?(negative?-Math.abs(x):x):0;
  }
  function xlsxDate(v){
    if(v instanceof Date&&!Number.isNaN(v.getTime()))return v.toISOString().slice(0,10);
    if(typeof v==='number'&&v>20000&&v<90000){const d=new Date(Date.UTC(1899,11,30)+Math.floor(v)*86400000);return d.toISOString().slice(0,10);}
    const s=String(v??'').trim();
    if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);
    const m=s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
    if(m){const d=new Date(Date.UTC(+m[3],+m[2]-1,+m[1]));return d.getUTCFullYear()===+m[3]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[1]?d.toISOString().slice(0,10):'';}
    return '';
  }
  function getSheetRows(ws){
    const all=[];
    ws.eachRow({includeEmpty:false},(row,index)=>{
      if(index>40100)return;
      const out=[];
      for(let i=1;i<=Math.min(100,Math.max(row.cellCount,row.actualCellCount));i++)out[i-1]=asCell(row.getCell(i).value);
      all[index-1]=out;
    });
    return all;
  }
  function scoreHeader(values){
    const used=new Set();let score=0;
    (values||[]).forEach(v=>{
      const z=norm(v);
      if(!z)return;
      for(const [key,patterns] of Object.entries(MATCHERS)){
        if(used.has(key))continue;
        if(patterns.some(p=>p.test(z))){used.add(key);score+=['date','revenue','sku'].includes(key)?3:1;break;}
      }
    });
    return score;
  }
  function setSheet(){
    if(!book)return;
    sheet=book.getWorksheet(Number($('retailSheetSelect').value));
    rows=getSheetRows(sheet);
    const options=$('retailHeaderRow');options.textContent='';
    let best=0,score=-1;
    for(let i=0;i<Math.min(rows.length,30);i++){
      const opt=document.createElement('option');opt.value=i;opt.textContent=`Строка ${i+1}: ${rows[i]?.filter(Boolean).slice(0,3).join(' · ').slice(0,85)||'пусто'}`;
      options.append(opt);
      if(scoreHeader(rows[i])>score){best=i;score=scoreHeader(rows[i]);}
    }
    options.disabled=false;options.value=String(best);
    setHeaders();
  }
  function setHeaders(){
    headerIndex=Number($('retailHeaderRow').value)||0;
    headers=(rows[headerIndex]||[]).map((v,i)=>String(v||'').trim()||`Колонка ${i+1}`);
    mapping={};const used=new Set();
    for(const [key,patterns] of Object.entries(MATCHERS)){
      const idx=headers.findIndex((h,i)=>!used.has(i)&&patterns.some(p=>p.test(norm(h))));
      if(idx>=0){mapping[key]=idx;used.add(idx);}else mapping[key]=-1;
    }
    drawMapping();
  }
  function drawMapping(){
    $('retailMappingPanel').hidden=false;
    const field=$('retailMappingFields');field.textContent='';
    for(const [key,label] of Object.entries(LABELS)){
      const wrapper=document.createElement('label');wrapper.textContent=label;
      const sel=document.createElement('select');sel.className='select';sel.dataset.mapKey=key;
      const none=new Option('— Нет столбца —','-1');sel.add(none);
      headers.forEach((v,i)=>sel.add(new Option(`${i+1}. ${v}`,String(i))));
      sel.value=String(mapping[key]??-1);
      sel.addEventListener('change',()=>{mapping[key]=Number(sel.value);preview();});
      wrapper.append(sel);field.append(wrapper);
    }
    preview();
  }
  function extract(){
    const valid=[],bad=[];
    if(mapping.date<0 || (mapping.revenue<0 && mapping.unitPrice<0))return {valid,bad,problem:'Выберите дату и сумму продажи (либо цену за единицу).'};
    for(let i=headerIndex+1;i<rows.length;i++){
      const cells=rows[i]||[];
      if(!cells.length || cells.every(v=>String(v??'').trim()===''))continue;
      const pick=key=>mapping[key]>=0?cells[mapping[key]]:'';
      const date=xlsxDate(pick('date'));
      const pname=String(pick('product')||'').trim();
      const sku=String(pick('sku')||'').trim();
      const rawOperation=String(pick('operation')||'').trim();
      const footer=/^(итого|всего|total)(\s|:|$)/i.test(String(cells.find(x=>String(x||'').trim())||''));
      if(!date){if(!footer)bad.push(i+1);continue;}
      const isReturn=/возврат|сторно|refund|return/i.test(rawOperation);
      let quantity=mapping.quantity>=0?numeric(pick('quantity')):1;
      let revenue=mapping.revenue>=0?numeric(pick('revenue')):numeric(pick('unitPrice'))*Math.abs(quantity);
      if(isReturn){quantity=-Math.abs(quantity);revenue=-Math.abs(revenue);}
      valid.push({index:valid.length,date,product:pname||sku||'Товар без наименования',sku,orderId:String(pick('orderId')||'').trim(),
        quantity,revenue,operation:rawOperation,commission:numeric(pick('commission')),logistics:numeric(pick('logistics')),cost:numeric(pick('cost'))});
      if(valid.length>40000)return {valid:[],bad,problem:'Отчёт содержит более 40 000 строк. Разделите выгрузку на несколько файлов.'};
    }
    return {valid,bad,problem:valid.length?'':'Нет ни одной строки с корректной датой и суммой продажи.'};
  }
  function preview(){
    const r=extract();
    const tbody=$('retailPreviewTable');
    tbody.innerHTML=r.valid.slice(0,7).map(x=>`<tr><td>${esc(x.date)}</td><td>${esc(x.sku||x.product)}</td><td>${count(x.quantity)}</td><td>${price(x.revenue)}</td></tr>`).join('')||'<tr><td colspan="4" class="empty-cell">Строки не распознаны.</td></tr>';
    $('retailPreviewNote').textContent=r.problem||`Распознано ${count(r.valid.length)} строк; пропущено ${count(r.bad.length)} строк без корректной даты или строк итогов. ${r.bad.length?'Первые проблемные строки Excel: '+r.bad.slice(0,7).join(', ')+'.':''} Проверьте показатели и сопоставление перед импортом.`;
    $('retailImportBtn').disabled=!!r.problem||importing;
    setUpload(r.problem||`Лист: ${sheet?.name}. Для загрузки подготовлено ${count(r.valid.length)} строк. ${r.bad.length?'Есть пропуски — проверьте даты.':'Предпросмотр готов.'}`,r.problem?'bad':r.bad.length?'warn':'good');
    return r;
  }
  async function onFile(e){
    const f=e.target.files?.[0];
    selectedFile=null;book=null;sha=null;
    $('retailMappingPanel').hidden=true;
    if(!f)return;
    if(!/\.xlsx$/i.test(f.name)){setUpload('Для .xls сохраните файл как .xlsx через Excel или LibreOffice.','bad');return;}
    if(f.size>20*1024*1024){setUpload('Файл больше 20 МБ. Разбейте отчёт на части.','bad');return;}
    if(!window.ExcelJS){setUpload('Не загрузилась библиотека ExcelJS. Проверьте доступ к cdn.jsdelivr.net или подключите библиотеку локально.','bad');return;}
    try{
      setUpload('Читаю Excel и проверяю структуру…');
      const bytes=await f.arrayBuffer();
      const hash=await crypto.subtle.digest('SHA-256',bytes);
      sha=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
      const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);
      book=wb;selectedFile=f;
      const select=$('retailSheetSelect');select.textContent='';
      wb.worksheets.forEach(ws=>select.add(new Option(`${ws.name} · ${count(ws.rowCount)} строк`,String(ws.id))));
      if(!wb.worksheets.length)throw new Error('В книге нет листов');
      select.disabled=false;select.value=String(wb.worksheets[0].id);setSheet();
    }catch(err){setUpload('Не удалось прочитать Excel: '+(err.message||err),'bad');book=null;selectedFile=null;}
  }
  async function doImport(){
    if(importing||!selectedFile||!sha)return;
    const {valid,bad,problem}=preview();if(problem)return;
    const overlaps=data.imports.filter(x=>x.status==='complete'&&x.dateFrom&&x.dateTo&&valid.some(r=>r.date>=x.dateFrom&&r.date<=x.dateTo));
    const message=`Загрузить ${valid.length} строк из «${selectedFile.name}»?${bad.length?' Пропущено строк: '+bad.length+'.':''}${overlaps.length?' ВНИМАНИЕ: есть пересечение дат с '+overlaps.map(x=>x.filename).slice(0,3).join(', ')+'. Дубли продаж суммируются.':''}`;
    if(!confirm(message))return;
    importing=true;$('retailImportBtn').disabled=true;
    let importId='';
    try{
      const start=await req('/api/retail/import/start','POST',{filename:selectedFile.name,hash:sha,sheet:sheet.name,rows:valid.length});
      importId=start.importId;
      for(let i=0;i<valid.length;i+=100){
        await req('/api/retail/import/chunk','POST',{importId,rows:valid.slice(i,i+100)});
        setUpload(`Загружаю продажи: ${count(Math.min(i+100,valid.length))} из ${count(valid.length)} строк…`);
      }
      const done=await req('/api/retail/import/finish','POST',{importId});
      setUpload(`Файл «${selectedFile.name}» сохранён: ${count(done.imported)} строк (${done.from} — ${done.to}).`,'good');
      await load(fromDate,toDate,siteSources,siteUtm);
    }catch(err){
      setUpload('Импорт не завершён: '+(err.message||err)+'. Незавершённый файл можно удалить в списке загрузок.','bad');
      await load(fromDate,toDate,siteSources,siteUtm).catch(()=>{});
    }finally{importing=false;$('retailImportBtn').disabled=false;}
  }
  function render(){
    const daily=data.daily||[],products=data.products||[],coverage=data.coverage||{},orders=data.orders||{};
    const total=(key)=>daily.reduce((a,d)=>a+n(d[key]),0);
    const gross=total('sales'),refunds=total('refunds'),revenue=total('revenue'),qty=total('quantity');
    const orderCnt=n(orders.value),noOrders=!n(orders.withOrderId);
    const cards=[
      ['Выручка от продаж',price(gross),'Положительные суммы в загруженных строках'],
      ['Возвраты',price(refunds),'Отрицательные суммы и операции возврата'],
      ['Чистая выручка',price(revenue),'Продажи за вычетом возвратов'],
      ['Товары, нетто',count(qty)+' шт.','Количество с учётом возвратов'],
      ['Заказы',noOrders?'—':count(orderCnt),noOrders?'В отчёте отсутствуют номера заказов':'Уникальные номера в выгрузке'],
      ['Комиссии + логистика',price(total('commission')+total('logistics')),'Только суммы из сопоставленных колонок']
    ];
    $('retailMetrics').innerHTML=cards.map(([title,value,note])=>`<article class="metric-card"><div class="metric-top"><div class="metric-title">${esc(title)}</div></div><div class="metric-value">${esc(value)}</div><div class="metric-note">${esc(note)}</div></article>`).join('');
    $('retailProductsTable').innerHTML=products.length?products.map(x=>`<tr><td>${esc(x.product)}</td><td>${esc(x.sku||'—')}</td><td>${count(x.quantity)}</td><td>${price(x.revenue)}</td><td>${count(x.rows)}</td></tr>`).join(''):'<tr><td colspan="5" class="empty-cell">За выбранный период продаж нет.</td></tr>';
    const files=(data.imports||[]).filter(x=>x.status==='complete');
    const overlaps=[];
    for(let i=0;i<files.length;i++)for(let j=i+1;j<files.length;j++)if(files[i].dateFrom&&files[j].dateFrom&&files[i].dateFrom<=files[j].dateTo&&files[j].dateFrom<=files[i].dateTo)overlaps.push([files[i].filename,files[j].filename]);
    $('retailDataQuality').innerHTML=`<strong>${count(coverage.rows||0)} строк продаж</strong> за период ${esc(fromDate)} — ${esc(toDate)}. Задействовано файлов: ${count(coverage.imports||0)}. ${daily.length?`Фактические даты: ${esc(coverage.firstDate)} — ${esc(coverage.lastDate)}.`:'Нет загруженных операций в выбранном периоде.'}<br><br>Чистая выручка вычитает возвраты, но не комиссии и логистику. Комиссии учитываются отдельно; прибыль без подтверждённой себестоимости считать нельзя.${overlaps.length?`<br><br><strong style="color:#a65b14">Внимание: ${overlaps.length} пересечений дат между файлами — возможен двойной учёт продаж.</strong>`:''}`;
    const refs=siteSources.filter(x=>/vseinstrumenti|все\s?инструмент/i.test(x.name||''));
    const utms=siteUtm.filter(x=>/vseinstrumenti|все\s?инструмент/i.test([x.source,x.medium,x.campaign].join(' ')));
    $('retailSiteSignal').innerHTML=`<strong>Сайт: переходы, связанные с ВсеИнструменты</strong><div>Источники Метрики: ${count(refs.reduce((a,x)=>a+n(x.visits),0))} визитов</div><div>UTM с упоминанием площадки: ${count(utms.reduce((a,x)=>a+n(x.visits),0))} визитов</div><small class="muted">Эти показатели относятся к переходам на ваш сайт и не измеряют просмотры карточек товара на маркетплейсе. Источники и UTM могут пересекаться — их не складывают.</small>`;
    const imp=data.imports||[];
    $('retailImportsTable').innerHTML=imp.length?imp.map(x=>`<tr><td>${esc(x.filename)} ${x.status==='pending'?'<span class="muted">(не завершён)</span>':''}<div class="muted">${esc(x.sheet||'')}</div></td><td>${esc(x.dateFrom||'—')} — ${esc(x.dateTo||'—')}</td><td>${count(x.rowCount)}</td><td>${esc(x.createdAt||'')}</td><td><button type="button" class="retail-delete" data-retail-delete="${esc(x.id)}">Удалить</button></td></tr>`).join(''):'<tr><td colspan="5" class="empty-cell">Файлы пока не загружены.</td></tr>';
    $('retailImportsTable').querySelectorAll('[data-retail-delete]').forEach(b=>b.addEventListener('click',()=>deleteImport(b.dataset.retailDelete)));
    if(chart){chart.destroy();chart=null;}
    if(window.Chart&&$('retailSalesChart')&&daily.length){
      chart=new Chart($('retailSalesChart'),{type:'line',data:{labels:daily.map(x=>x.date.slice(5)),datasets:[
        {label:'Чистая выручка',data:daily.map(x=>n(x.revenue)),borderColor:'#597acb',backgroundColor:'rgba(89,122,203,.13)',fill:true,tension:.25},
        {label:'Возвраты',data:daily.map(x=>n(x.refunds)),borderColor:'#e29a5b',backgroundColor:'rgba(226,154,91,.12)',fill:false,tension:.25}
      ]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:true,position:'bottom'}},scales:{x:{grid:{display:false},ticks:{maxTicksLimit:9}},y:{beginAtZero:false,ticks:{callback:v=>new Intl.NumberFormat('ru-RU',{notation:'compact'}).format(v)+' ₽'}}}}});
    }
  }
  async function deleteImport(id){
    const item=data.imports?.find(x=>x.id===id);if(!item)return;
    if(!confirm(`Удалить файл «${item.filename}» и все связанные строки продаж? Действие нельзя отменить.`))return;
    try{await req('/api/retail/import/'+encodeURIComponent(id),'DELETE');await load(fromDate,toDate,siteSources,siteUtm);}
    catch(e){setUpload('Не удалось удалить файл: '+e.message,'bad');}
  }
  async function load(from,to,sources=[],utms=[]){
    if(!from||!to)return;
    fromDate=from;toDate=to;siteSources=Array.isArray(sources)?sources:[];siteUtm=Array.isArray(utms)?utms:[];
    try{data=await req(`/api/retail?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);render();}
    catch(e){$('retailDataQuality').textContent='Не удалось загрузить данные розницы: '+e.message;}
  }
  function init(){
    if(initDone)return;initDone=true;
    $('retailFile')?.addEventListener('change',onFile);
    $('retailSheetSelect')?.addEventListener('change',setSheet);
    $('retailHeaderRow')?.addEventListener('change',setHeaders);
    $('retailImportBtn')?.addEventListener('click',doImport);
    $('retailReloadBtn')?.addEventListener('click',()=>load(fromDate,toDate,siteSources,siteUtm));
  }
  window.CSRetail={init,load,isImporting:()=>importing};
})();
