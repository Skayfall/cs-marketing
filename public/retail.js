// CS Marketing v2.10: factual period reports from ВсеИнструменты (.xlsx); D1-backed analytics.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = v => Number(v) || 0;
  const money = v => new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(num(v));
  const integer = v => new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(num(v));
  const norm = s => String(s ?? '').toLowerCase().replace(/[\s\u00a0_–—-]+/g,' ').replace(/[:.,()]+/g,'').trim();
  const fields = {
    brand:'Бренд', product:'Наименование товара', sku:'Артикул / SKU',
    revenue:'Выручка без НДС, ₽ *', quantity:'Количество, шт. *', marginPct:'Маржинальность, % (если есть)'
  };
  const match = {
    brand:[/^бренд$/i,/^brand$/i],
    product:[/^наименование товар/i,/^название товара$/i,/^товар$/i,/^product$/i],
    sku:[/^артикул/i,/^sku$/i,/^код товара/i],
    revenue:[/выручка/i,/сумма продаж/i,/сумма реализации/i,/revenue/i],
    quantity:[/^кол во/i,/^количество/i,/^шт$/i,/^quantity$/i],
    marginPct:[/маржинальност/i,/^маржа %$/i,/^margin/i]
  };
  let book=null,sheet=null,selectedFile=null,sha=null,rows=[],headers=[],headerIndex=0,mapping={},suggestedPeriod=null;
  let dashboard={imports:[],products:[],history:[],summary:{},partial:[]},fromDate='',toDate='',chart=null,importing=false,initDone=false;
  function setUpload(message,style=''){const node=$('retailUploadState');node.textContent=message;node.className='retail-upload-state '+style;}
  async function req(url,method='GET',body){
    const response=await fetch(url,{method,credentials:'include',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(method==='GET'?25000:45000)});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);
    return payload;
  }
  function asCell(value){
    if(value==null)return '';
    if(value instanceof Date)return value;
    if(typeof value==='object'){
      if(Object.hasOwn(value,'result'))return asCell(value.result);
      if(Array.isArray(value.richText))return value.richText.map(x=>x.text||'').join('');
      if(Object.hasOwn(value,'text'))return String(value.text||'');
      return '';
    }
    return value;
  }
  function toNumber(value){
    if(typeof value==='number')return Number.isFinite(value)?value:NaN;
    if(value==null||String(value).trim()==='')return NaN;
    let s=String(value).trim().replace(/[\s\u00a0₽]/g,'').replace(/руб(лей|\.)?/gi,'');
    const negative=/^\(.*\)$/.test(s);
    s=s.replace(/[()]/g,'').replace(/[^\d,.+\-]/g,'');
    if(s.includes(',')&&s.includes('.'))s=s.lastIndexOf(',')>s.lastIndexOf('.')?s.replace(/\./g,'').replace(',','.'):s.replace(/,/g,'');
    else if(s.includes(','))s=s.replace(',','.');
    const x=Number(s);return Number.isFinite(x)?(negative?-Math.abs(x):x):NaN;
  }
  function isoDate(value){
    const input=String(value||'').trim();
    const m=input.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if(!m)return /^\d{4}-\d{2}-\d{2}$/.test(input)&&!isNaN(Date.parse(input+'T12:00:00Z'))?input:'';
    const d=new Date(Date.UTC(+m[3],+m[2]-1,+m[1]));
    return d.getUTCFullYear()===+m[3]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[1]?d.toISOString().slice(0,10):'';
  }
  function readable(date){const m=String(date||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}.${m[2]}.${m[1]}`:String(date||'');}
  function detectPeriod(sheetRows){
    const intro=sheetRows.slice(0,40).flatMap(r=>Array.isArray(r)?r:[]).map(v=>String(v||'')).join(' ');
    const match=intro.match(/период\s+с\s+(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})\s+по\s+(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/i);
    const reported=intro.match(/отч[её]т\s+по\s+продажам\s+от\s+(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/i);
    return {from:match?isoDate(match[1]):'',to:match?isoDate(match[2]):'',reportDate:reported?isoDate(reported[1]):''};
  }
  function getSheetRows(ws){
    const output=[];
    ws.eachRow({includeEmpty:false},(row,index)=>{
      if(index>40100)return;
      const vals=[];
      for(let i=1;i<=Math.min(80,Math.max(row.cellCount,row.actualCellCount));i++)vals[i-1]=asCell(row.getCell(i).value);
      output[index-1]=vals;
    });
    return output;
  }
  function headerScore(values){
    const matched=new Set();let points=0;
    (values||[]).forEach(v=>{
      const s=norm(v);
      for(const [key,patterns] of Object.entries(match)){
        if(!matched.has(key)&&patterns.some(p=>p.test(s))){matched.add(key);points+=['revenue','sku','quantity'].includes(key)?3:1;break;}
      }
    });
    return points;
  }
  function setSheet(){
    if(!book)return;
    sheet=book.getWorksheet(Number($('retailSheetSelect').value));
    rows=getSheetRows(sheet);suggestedPeriod=detectPeriod(rows);
    $('retailPeriodFrom').value=suggestedPeriod.from;
    $('retailPeriodTo').value=suggestedPeriod.to;
    const select=$('retailHeaderRow');select.textContent='';let best=0,bestScore=-1;
    for(let i=0;i<Math.min(45,rows.length);i++){
      const score=headerScore(rows[i]);
      select.add(new Option(`Строка ${i+1}: ${(rows[i]||[]).filter(v=>v!==''&&v!=null).slice(0,2).join(' · ').slice(0,85)||'пусто'}`,String(i)));
      if(score>bestScore){bestScore=score;best=i;}
    }
    select.disabled=false;select.value=String(best);setHeaders();
  }
  function setHeaders(){
    headerIndex=Number($('retailHeaderRow').value)||0;
    headers=(rows[headerIndex]||[]).map((v,i)=>String(v||'').trim()||`Столбец ${i+1}`);
    mapping={};const used=new Set();
    for(const [key,patterns] of Object.entries(match)){
      const i=headers.findIndex((h,j)=>!used.has(j)&&patterns.some(p=>p.test(norm(h))));
      mapping[key]=i;if(i>=0)used.add(i);
    }
    const holder=$('retailMappingFields');holder.textContent='';
    for(const [key,title] of Object.entries(fields)){
      const label=document.createElement('label');label.textContent=title;
      const select=document.createElement('select');select.className='select';
      select.add(new Option('— Нет столбца —','-1'));
      headers.forEach((s,i)=>select.add(new Option(`${i+1}. ${s}`,String(i))));
      select.value=String(mapping[key]??-1);
      select.addEventListener('change',()=>{mapping[key]=Number(select.value);preview();});
      label.append(select);holder.append(label);
    }
    $('retailMappingPanel').hidden=false;preview();
  }
  function extract(){
    const valid=[],bad=[];
    const start=$('retailPeriodFrom').value,end=$('retailPeriodTo').value;
    if(!start||!end||start>end)return {valid,bad,problem:'Укажите корректные даты начала и конца отчёта.'};
    if(mapping.revenue<0||mapping.quantity<0||mapping.sku<0&&mapping.product<0)
      return {valid,bad,problem:'Сопоставьте выручку, количество и артикул или название товара.'};
    for(let i=headerIndex+1;i<rows.length;i++){
      const cells=rows[i]||[];
      if(!cells.length||cells.every(x=>String(x??'').trim()===''))continue;
      const value=key=>mapping[key]>=0?cells[mapping[key]]:'';
      const title=String(value('product')||'').trim(),sku=String(value('sku')||'').trim();
      if(!title&&!sku)continue;
      const revenue=toNumber(value('revenue')),quantity=toNumber(value('quantity'));
      if(!Number.isFinite(revenue)||!Number.isFinite(quantity)){
        // Blank subtotal/footer rows are ignored; SKU rows with broken amounts are reported as errors.
        if(/^(итого|всего|total)/i.test(title))continue;
        bad.push(i+1);continue;
      }
      const margin=toNumber(value('marginPct'));
      valid.push({index:valid.length,brand:String(value('brand')||'').trim(),product:title||sku,sku,
        revenue,quantity,marginPct:Number.isFinite(margin)?margin:null});
      if(valid.length>40000)return {valid:[],bad,problem:'Слишком много строк (более 40 000). Разбейте отчёт на части.'};
    }
    const problem=bad.length?`В ${bad.length} строках с товарами обнаружены некорректные числа: ${bad.slice(0,8).join(', ')}. Исправьте файл или сопоставление.`:
      !valid.length?'В файле не обнаружены корректные продажи. Проверьте выбранную строку заголовков.':'';
    return {valid,bad,problem,start,end};
  }
  function preview(){
    const r=extract();
    $('retailPreviewTable').innerHTML=r.valid.slice(0,8).map(x=>`<tr><td>${esc(x.sku||'—')}</td><td>${esc(x.product)}</td><td>${integer(x.quantity)}</td><td>${money(x.revenue)}</td><td>${x.marginPct===null?'—':integer(x.marginPct)+'%'}</td></tr>`).join('')||'<tr><td colspan="5" class="empty-cell">Нет распознанных товаров.</td></tr>';
    $('retailImportBtn').disabled=!!r.problem||importing;
    const net=r.valid.reduce((a,x)=>a+x.revenue,0),qty=r.valid.reduce((a,x)=>a+x.quantity,0);
    $('retailPreviewNote').textContent=r.problem||`Период ${readable(r.start)}–${readable(r.end)} · ${integer(r.valid.length)} строк SKU · ${money(net)} без НДС · ${integer(qty)} шт. Даты отдельных продаж в этом отчёте отсутствуют.`;
    if(selectedFile)setUpload(r.problem||`Файл готов к импорту: ${integer(r.valid.length)} строк, ${money(net)}. Проверьте период и суммы.`,r.problem?'bad':'good');
    return r;
  }
  async function onFile(event){
    selectedFile=null;book=null;sha=null;$('retailMappingPanel').hidden=true;
    const f=event.target.files?.[0];if(!f)return;
    if(!/\.xlsx$/i.test(f.name)){setUpload('Поддерживаются файлы Excel .xlsx.','bad');return;}
    if(f.size>20*1024*1024){setUpload('Файл больше 20 МБ: разбейте выгрузку.','bad');return;}
    if(!window.ExcelJS){setUpload('Не загрузилась библиотека ExcelJS. Проверьте соединение с cdn.jsdelivr.net.','bad');return;}
    try{
      setUpload('Читаю структуру Excel…');const bytes=await f.arrayBuffer();
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      sha=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
      const instance=new ExcelJS.Workbook();await instance.xlsx.load(bytes);
      if(!instance.worksheets.length)throw Error('В книге нет листов');
      book=instance;selectedFile=f;
      const choice=$('retailSheetSelect');choice.textContent='';
      book.worksheets.forEach(ws=>choice.add(new Option(`${ws.name} · ${integer(ws.rowCount)} строк`,String(ws.id))));
      choice.disabled=false;choice.value=String(book.worksheets[0].id);setSheet();
    }catch(e){selectedFile=null;book=null;setUpload('Не удалось прочитать Excel: '+(e.message||e),'bad');}
  }
  async function importFile(){
    if(importing||!selectedFile||!sha)return;
    const {valid,problem,start,end}=preview();if(problem)return;
    const clashes=(dashboard.imports||[]).filter(x=>x.status==='complete'&&x.periodFrom<=end&&x.periodTo>=start);
    if(clashes.length){setUpload('Нельзя импортировать пересекающийся период. Сначала удалите или замените '+clashes[0].filename+'.','bad');return;}
    if(!confirm(`Импортировать ${integer(valid.length)} строк за ${readable(start)}–${readable(end)}? Сумма: ${money(valid.reduce((a,x)=>a+x.revenue,0))}.`))return;
    importing=true;$('retailImportBtn').disabled=true;let id='';
    try{
      const startResult=await req('/api/retail/reports/import/start','POST',{hash:sha,filename:selectedFile.name,
        sheet:sheet.name,periodFrom:start,periodTo:end,reportDate:suggestedPeriod?.reportDate||'',rows:valid.length});
      id=startResult.importId;
      for(let i=0;i<valid.length;i+=75){
        await req('/api/retail/reports/import/chunk','POST',{importId:id,rows:valid.slice(i,i+75)});
        setUpload(`Сохраняю отчёт: ${integer(Math.min(i+75,valid.length))} из ${integer(valid.length)} строк…`);
      }
      await req('/api/retail/reports/import/finish','POST',{importId:id});
      await load(fromDate,toDate);
      setUpload(`Файл сохранён в D1: ${readable(start)}–${readable(end)}, ${integer(valid.length)} строк.`, 'good');
      $('retailFile').value='';selectedFile=null;$('retailMappingPanel').hidden=true;
    }catch(e){setUpload(`Импорт не завершён: ${e.message}. ${id?'Незавершённый импорт можно удалить в истории.':''}`,'bad');await load(fromDate,toDate).catch(()=>{});}
    finally{importing=false;$('retailImportBtn').disabled=!selectedFile;}
  }
  function render(){
    const s=dashboard.summary||{},selected=dashboard.imports?.filter(x=>dashboard.selectedIds?.includes(x.id))||[];
    const comp=dashboard.comparison||{},amount=num(s.revenue),ratio=comp.changePct;
    const cmpNote=comp.previous?`К ${readable(comp.previous.periodFrom)}–${readable(comp.previous.periodTo)}.`:
      comp.expected?`Для сравнения нужен отчёт ${readable(comp.expected.from)}–${readable(comp.expected.to)}.`:
      'Сравниваются только одинаковые по охвату периоды.';
    const cards=[
      ['Выручка без НДС',money(amount),'Нетто за загруженные периоды'],
      ['Динамика к прошлому месяцу',ratio===null||ratio===undefined?'—':`${ratio>0?'+':''}${integer(ratio)}%`,cmpNote],
      ['Продажи, шт.',integer(s.quantity||0),'Количество с учётом отрицательных корректировок'],
      ['Товарных строк',integer(s.positions||0),'SKU-строки из выбранных отчётов'],
      ['Отрицательные корректировки',money(s.negative||0),'Отрицательная выручка; тип операции в файле не указан'],
      ['Маржинальность (расчётная)',s.marginPct===null||s.marginPct===undefined?'—':integer(s.marginPct)+'%', 'Взвешена по положительной выручке с заполненным процентом']
    ];
    $('retailMetrics').innerHTML=cards.map(([name,value,note])=>`<article class="metric-card"><div class="metric-top"><div class="metric-title">${esc(name)}</div></div><div class="metric-value">${esc(value)}</div><div class="metric-note">${esc(note)}</div></article>`).join('');
    const products=dashboard.products||[],base=num(s.revenue);
    $('retailProductsTable').innerHTML=products.length?products.map(x=>{
      const margin=num(x.marginDenominator)>0?integer(num(x.marginNumerator)/num(x.marginDenominator))+'%':'—';
      const share=base>0?integer(100*num(x.revenue)/base)+'%':'—';
      return `<tr><td>${esc(x.product)}</td><td>${esc(x.sku||'—')}</td><td>${integer(x.quantity)}</td><td>${money(x.revenue)}</td><td>${esc(share)}</td><td>${esc(margin)}</td></tr>`;
    }).join(''):'<tr><td colspan="6" class="empty-cell">Нет загруженных отчётов в выбранном периоде.</td></tr>';
    const parts=[];
    parts.push(`<strong>${integer(selected.length)} отчётов</strong> полностью попадают в выбранные даты ${esc(readable(fromDate))}–${esc(readable(toDate))}.`);
    parts.push('Отчёты содержат суммы за период по SKU. Точные даты покупок и число заказов отсутствуют. График построен по периодам отчётов.');
    parts.push('Выручка указана без НДС. Отрицательные корректировки выделены отдельно; их нельзя однозначно считать возвратами. Маржинальность взвешена по положительной выручке, поэтому не является рассчитанной чистой прибылью.');
    if(s.marginCoverage>0)parts.push(`Доля положительной выручки с корректно интерпретируемой маржинальностью: ${integer(100*num(s.marginCoverage)/(num(s.gross)||1))}%.`);
    if(s.marginOutliers)parts.push(`<strong class="retail-attention">Аномальная маржинальность: ${integer(s.marginOutliers)} строк. Сохраняем их продажи, но исключаем экстремальные проценты за пределами −200…100% из расчёта средневзвешенного показателя.</strong>`);
    if((dashboard.partial||[]).length)parts.push(`<strong class="retail-attention">${dashboard.partial.length} отчётов пересекают выбранные даты, но не входят в них целиком. Их суммы исключены, чтобы не делить продажи по дням наугад.</strong>`);
    $('retailDataQuality').innerHTML=parts.map(x=>`<p>${x}</p>`).join('');
    const history=dashboard.history||[];
    $('retailHistoryInfo').textContent=history.length?`Последние ${history.length} завершённых периодов. Даты на графике обозначают интервал отчёта, а не даты покупок.`:'Добавь первую выгрузку, чтобы построить динамику.';
    const list=dashboard.imports||[];
    $('retailImportsTable').innerHTML=list.length?list.map(x=>`<tr><td>${esc(x.filename)}<div class="muted">${esc(x.sheet||'')}</div></td><td>${esc(readable(x.periodFrom))}–${esc(readable(x.periodTo))}</td><td>${integer(x.rowCount)} ${x.status==='pending'?'(не завершён)':''}</td><td>${money(x.revenue)}</td><td>${esc(x.createdAt||'')}</td><td><button type="button" class="retail-delete" data-retail-delete="${esc(x.id)}">Удалить</button></td></tr>`).join(''):'<tr><td colspan="6" class="empty-cell">Отчёты ещё не загружены.</td></tr>';
    $('retailImportsTable').querySelectorAll('[data-retail-delete]').forEach(b=>b.addEventListener('click',()=>deleteFile(b.dataset.retailDelete)));
    if(chart){chart.destroy();chart=null;}
    if(window.Chart&&history.length){
      chart=new Chart($('retailSalesChart'),{type:'bar',data:{labels:history.map(x=>`${readable(x.periodFrom).slice(0,5)}–${readable(x.periodTo)}`),datasets:[
        {label:'Положительная выручка',data:history.map(x=>num(x.gross)),backgroundColor:'rgba(91,92,246,.8)',borderRadius:5},
        {label:'Отрицательные корректировки',data:history.map(x=>-num(x.negative)),backgroundColor:'rgba(231,137,90,.85)',borderRadius:5}
      ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,position:'bottom'}},scales:{x:{ticks:{maxRotation:45,minRotation:0}},y:{ticks:{callback:x=>new Intl.NumberFormat('ru-RU',{notation:'compact'}).format(x)+' ₽'}}}}});
    }
  }
  async function deleteFile(id){
    const file=dashboard.imports?.find(x=>x.id===id);if(!file)return;
    if(!confirm(`Удалить отчёт «${file.filename}» за ${readable(file.periodFrom)}–${readable(file.periodTo)}? Его данные исчезнут из графиков.`))return;
    try{await req('/api/retail/reports/import/'+encodeURIComponent(id),'DELETE');await load(fromDate,toDate);setUpload('Отчёт удалён.','good');}
    catch(e){setUpload('Не удалось удалить: '+e.message,'bad');}
  }
  async function load(from,to){
    if(!from||!to)return;
    fromDate=from;toDate=to;
    try{dashboard=await req(`/api/retail/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);render();}
    catch(e){$('retailDataQuality').textContent='Не удалось получить отчёты из D1: '+e.message;}
  }
  async function showCounters(){
    const panel=$('metrikaCounterCheck'),button=$('metrikaCounterCheckBtn');
    panel.textContent='Проверяю доступ Яндекс Метрики…';button.disabled=true;
    try{
      const result=await req('/api/metrika/counters');const ids=result.retailIds||[];
      const counters=result.counters||[];
      panel.innerHTML=`<strong>Доступно счётчиков: ${integer(counters.length)}</strong>. Основной: ${esc(result.primaryId||'не выбран')}. Розничные: ${esc(ids.join(', ')||'ещё не настроены')}.<div class="table-scroll"><table><thead><tr><th>ID</th><th>Название</th><th>Сайт</th><th>Доступ</th></tr></thead><tbody>${counters.map(c=>`<tr><td>${esc(c.id)}</td><td>${esc(c.name)}</td><td>${esc(c.site)}</td><td>${esc(c.permission)}</td></tr>`).join('')}</tbody></table></div>`;
    }catch(e){panel.textContent='Проверка доступа не прошла: '+e.message;}
    finally{button.disabled=false;}
  }
  function init(){
    if(initDone)return;initDone=true;
    $('retailFile')?.addEventListener('change',onFile);
    $('retailSheetSelect')?.addEventListener('change',setSheet);
    $('retailHeaderRow')?.addEventListener('change',setHeaders);
    $('retailPeriodFrom')?.addEventListener('change',preview);
    $('retailPeriodTo')?.addEventListener('change',preview);
    $('retailImportBtn')?.addEventListener('click',importFile);
    $('retailReloadBtn')?.addEventListener('click',()=>load(fromDate,toDate));
    $('metrikaCounterCheckBtn')?.addEventListener('click',showCounters);
  }
  window.CSRetail={init,load,isImporting:()=>importing};
})();
