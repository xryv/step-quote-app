// step-quote-app front-end
// Importação real de STEP -> JSON (header, entidades) + worker OCCT (bbox & volume).
// Diagnóstico (BBox, Volume, Remoção, Faces, Círculos) + sliders live (seg/face, seg/furo).
// Política de preços: Q1 = peça piloto; descontos por quantidade (tiers em config).

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const state = {
  file: null,
  fileMeta: null,
  params: null,
  storageKey: 'SQ_PARAMS_V1',
  stepJson: null,    // JSON derivado do STEP
  lastCalc: null     // cache último cálculo (para export)
};

/* ----------------------- Helpers UI ----------------------- */
function toast(msg, ms=2200){
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(()=> el.classList.add('hidden'), ms);
}
function humanSize(bytes){
  const u = ['B','KB','MB','GB']; let i=0; let v=bytes;
  while(v>=1024 && i<u.length-1){ v/=1024; i++; }
  return `${v.toFixed(v<10?2:1)} ${u[i]}`;
}
function setStep(step){
  $$('.step').forEach(li => {
    const n = li.getAttribute('data-step');
    const active = Number(n)<=step;
    li.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
    li.querySelector('span').style.color = active ? '#001014' : 'var(--accent)';
    li.querySelector('span').style.background = active ? 'linear-gradient(90deg,var(--accent),var(--accent-2))' : 'var(--panel-2)';
  });
  $('#panelUpload').classList.toggle('hidden', step!==1);
  $('#panelParams').classList.toggle('hidden', step!==2);
  $('#panelResults').classList.toggle('hidden', step!==3);
}

/* ----------------------- Parse STEP textual ----------------------- */
function safeMatch(re, str, idx=1){ const m = re.exec(str); return m ? (m[idx]||'').trim() : ''; }
function parseHeader(text){
  const blk = (/HEADER\s*;(.*?)ENDSEC\s*;/is.exec(text)||[])[1] || '';
  const header = {
    FILE_SCHEMA: safeMatch(/FILE_SCHEMA\s*\(\s*\(\s*'(.*?)'\s*\)\s*\)\s*;/si, blk),
    FILE_DESCRIPTION: safeMatch(/FILE_DESCRIPTION\s*\(\s*\(\s*'(.*?)'\s*\)\s*,\s*'(.*?)'\s*\)\s*;/si, blk),
    FILE_NAME: safeMatch(/FILE_NAME\s*\(\s*'(.*?)'/si, blk),
    timestamp: safeMatch(/FILE_NAME\s*\(\s*'(.*?)'\s*,\s*'(.*?)'/si, blk, 2),
    author: safeMatch(/FILE_NAME\s*\(\s*'(.*?)'\s*,\s*'(.*?)'\s*,\s*\(\s*'(.*?)'\s*\)/si, blk, 3),
    organization: safeMatch(/FILE_NAME\s*\(\s*'(.*?)'\s*,\s*'(.*?)'\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*\(\s*'(.*?)'\s*\)/si, blk, 4),
    preprocessor: safeMatch(/FILE_NAME\s*\(\s*'(.*?)'\s*,\s*'(.*?)'\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*'(.*?)'/si, blk, 5),
    originatingSystem: safeMatch(/FILE_NAME\s*\(\s*'(.*?)'\s*,\s*'(.*?)'\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*'(.*?)'\s*,\s*'(.*?)'/si, blk, 6)
  };
  return header;
}
function parseEntities(text){
  const dataBlk = (/DATA\s*;(.*?)ENDSEC\s*;/is.exec(text)||[])[1] || '';
  const hist = {};
  const re = /^\s*#\d+\s*=\s*([A-Z0-9_]+)\s*\(/gm;
  let m; while ((m = re.exec(dataBlk)) !== null) {
    const t = m[1]; hist[t] = (hist[t]||0)+1;
  }
  return hist;
}

/* ----------------------- Worker OCCT ----------------------- */
function runOcctWorker(fileBuffer, unit='millimeter'){
  return new Promise((resolve) => {
    const w = new Worker('./js/occt-worker.js');
    w.onmessage = (e) => { resolve(e.data); w.terminate(); };
    w.postMessage({ fileBuffer, unit });
  });
}

// Fallback: se o worker falhar, carregamos o OCCT no main thread via <script> UMD
async function computeGeometryInMainThread(fileBuffer, unit='millimeter') {
  if (!window.__occtLoaded) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/vendor/occt/occt-import-js.js';
      s.onload = () => { window.__occtLoaded = true; res(); };
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  const factory = (window.occtimportjs || window.self?.occtimportjs);
  if (typeof factory !== 'function') throw new Error('OCCT runtime not found in main thread.');
  const occt = await factory();
  const bytes = new Uint8Array(fileBuffer);
  const res = occt.ReadStepFile(bytes, { linearUnit: unit });
  if (!res || !res.success) throw new Error('OCCT(ReadStepFile) failed in main thread.');

  const meshes = res.meshes || [];
  if (!meshes.length) throw new Error('OCCT: no meshes');

  let min = [ Infinity, Infinity, Infinity ];
  let max = [ -Infinity, -Infinity, -Infinity ];
  let approxVolume = 0;
  for (const m of meshes) {
    const v = (m.attributes?.position?.array) || m.vertices || m.points || [];
    const idx = (m.index?.array) || m.indices || [];
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i], y = v[i+1], z = v[i+2];
      if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
    }
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i]*3, b = idx[i+1]*3, c = idx[i+2]*3;
      const ax = v[a], ay = v[a+1], az = v[a+2];
      const bx = v[b], by = v[b+1], bz = v[b+2];
      const cx = v[c], cy = v[c+1], cz = v[c+2];
      // ✅ acumula /6 por triângulo
      approxVolume += (ax*(by*cz - bz*cy) - ay*(bx*cz - bz*cx) + az*(bx*cy - by*cx)) / 6.0;
    }
  }
  approxVolume = Math.abs(approxVolume);

  const size = [ max[0]-min[0], max[1]-min[1], max[2]-min[2] ];
  return {
    ok: true,
    geometry: {
      unit,
      bbox: { min, max },
      size: { x: size[0], y: size[1], z: size[2] },
      volumeApprox: approxVolume
    }
  };
}

/* ----------------------- Upload Binding ----------------------- */
function bindUpload(){
  const dz = $('#dropzone');
  const inp = $('#fileInput');
  const pick = () => inp.click();
  const setHover = on => dz.classList.toggle('hover', !!on);

  dz.addEventListener('click', pick);
  dz.addEventListener('keydown', e => { if(e.key==='Enter' || e.key===' ') pick(); });
  dz.addEventListener('dragover', e => { e.preventDefault(); setHover(true); });
  dz.addEventListener('dragleave', () => setHover(false));
  dz.addEventListener('drop', e => { e.preventDefault(); setHover(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); });
  inp.addEventListener('change', e => { const f = e.target.files?.[0]; if (f) handleFile(f); });

  async function handleFile(f){
    if(!/\.(step|stp)$/i.test(f.name)){ toast('Ficheiro inválido. Use .step ou .stp'); return; }

    state.file = f;
    state.fileMeta = { name: f.name, size: f.size, date: new Date(f.lastModified).toLocaleString('pt-PT') };
    $('#fiName').textContent = state.fileMeta.name;
    $('#fiSize').textContent = humanSize(state.fileMeta.size);
    $('#fiDate').textContent = state.fileMeta.date;
    $('#fileInfo').classList.remove('hidden');
    $('#toParamsBtn').disabled = true;

    toast('A processar STEP…');

    const [text, buffer] = await Promise.all([ f.text(), f.arrayBuffer() ]);

    const header = parseHeader(text);
    const entities = parseEntities(text);
    const totalEntities = Object.values(entities).reduce((a,b)=>a+b,0);

    const unit = $('#units')?.value || 'millimeter';
    let occt = await runOcctWorker(buffer, unit);

    // ✅ Fallback se o worker falhar
    if (!occt.ok) {
      console.warn('OCCT worker falhou:', occt.error);
      toast('Worker falhou. A calcular no próprio browser…');
      try {
        occt = await computeGeometryInMainThread(buffer, unit);
      } catch (e) {
        console.error('Fallback OCCT falhou:', e);
      }
    }

    state.stepJson = {
      tool: 'in-app-step2json',
      version: '0.1.0',
      file: { name: f.name, sizeBytes: f.size },
      header,
      summary: { totalEntities, uniqueTypes: Object.keys(entities).length },
      entities,
      geometry: occt.ok ? occt.geometry : undefined
    };

    $('#toParamsBtn').disabled = false;
    toast('STEP processado. Revê parâmetros e calcula.');
  }
}

/* ----------------------- Params & Storage ----------------------- */
function loadParamsFromStorage(){ try { const raw = localStorage.getItem(state.storageKey); return raw ? JSON.parse(raw) : null; } catch { return null; } }
function saveParamsToStorage(){ try { localStorage.setItem(state.storageKey, JSON.stringify(state.params)); } catch {} }

function fillSelectOptions(){
  const matSel = $('#materialKey'); matSel.innerHTML='';
  Object.entries(window.SQ_CONFIG.materials).forEach(([k,v])=>{
    const o=document.createElement('option'); o.value=k; o.textContent=`${v.name} (${k})`; matSel.appendChild(o);
  });
  const macSel = $('#machineKey'); macSel.innerHTML='';
  Object.entries(window.SQ_CONFIG.machines).forEach(([k,v])=>{
    const o=document.createElement('option'); o.value=k; o.textContent=`${v.name} (${k})`; macSel.appendChild(o);
  });
}
function setFormFromParams(p){
  $('#materialKey').value = p.materialKey;
  $('#density').value = p.material.density_g_cm3;
  $('#costPerKg').value = p.material.cost_per_kg;
  $('#mrrRough').value = p.material.mrr_rough_cm3_min;
  $('#mrrFinish').value = p.material.mrr_finish_cm3_min;

  $('#machineKey').value = p.machineKey;
  $('#hourlyRate').value = p.machine.hourly_rate;
  $('#setupMin').value = p.machine.setup_minutes;

  $('#stockFactor').value = p.globals.stock_factor;
  $('#secPerFace').value = p.globals.seconds_per_face;
  $('#secPerHole').value = p.globals.seconds_per_hole;
  $('#wearPerCm3').value = p.globals.wear_per_cm3;
  $('#overheadMult').value = p.globals.overhead_mult;
  $('#marginMult').value = p.globals.margin_mult;
  $('#units').value = p.globals.units;
  $('#currency').value = p.globals.currency;

  $('#q1').value = p.globals.batches[0] ?? 1;
  $('#q10').value = p.globals.batches[1] ?? 10;
  $('#q50').value = p.globals.batches[2] ?? 50;
  $('#q100').value = p.globals.batches[3] ?? 100;

  // sliders
  $('#sliderFace').value = p.globals.seconds_per_face;
  $('#sliderHole').value = p.globals.seconds_per_hole;
  $('#sliderFaceVal').textContent = `${Number(p.globals.seconds_per_face).toFixed(1)}s`;
  $('#sliderHoleVal').textContent = `${Number(p.globals.seconds_per_hole).toFixed(1)}s`;
}
function snapshotParams(){
  const matKey = $('#materialKey').value;
  const macKey = $('#machineKey').value;
  const p = {
    materialKey: matKey,
    machineKey: macKey,
    material: {
      density_g_cm3: Number($('#density').value),
      cost_per_kg: Number($('#costPerKg').value),
      mrr_rough_cm3_min: Number($('#mrrRough').value),
      mrr_finish_cm3_min: Number($('#mrrFinish').value)
    },
    machine: {
      hourly_rate: Number($('#hourlyRate').value),
      setup_minutes: Number($('#setupMin').value)
    },
    globals: {
      stock_factor: Number($('#stockFactor').value),
      seconds_per_face: Number($('#secPerFace').value),
      seconds_per_hole: Number($('#secPerHole').value),
      wear_per_cm3: Number($('#wearPerCm3').value),
      overhead_mult: Number($('#overheadMult').value),
      margin_mult: Number($('#marginMult').value),
      units: $('#units').value,
      currency: $('#currency').value,
      batches: [ Number($('#q1').value), Number($('#q10').value), Number($('#q50').value), Number($('#q100').value) ],
      discounts: SQ_CONFIG.globals.discounts || []
    }
  };
  state.params = p; saveParamsToStorage(); return p;
}

/* ----------------------- Formatação ----------------------- */
const CURRENCY_SYMBOLS = { EUR:'€', USD:'$', GBP:'£' };
const fmtNumber = v => new Intl.NumberFormat('pt-PT',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
const fmtMoney  = (v,c='EUR') => `${fmtNumber(v)}${CURRENCY_SYMBOLS[c] || ` ${c}`}`;
const fmtMin    = min => `${Math.round(min)}min`;

/* ----------------------- Descontos por quantidade ----------------------- */
function getQtyDiscountPct(q, tiers){ let pct=0; for(const t of (tiers||[])){ if(q>=t.minQty) pct=t.pct; } return pct; }

/* ----------------------- Unidades ----------------------- */
function mmFactor(unit){
  switch((unit||'millimeter').toLowerCase()){
    case 'millimeter': return 1;
    case 'centimeter': return 10;
    case 'meter':      return 1000;
    case 'inch':       return 25.4;
    case 'foot':       return 304.8;
    default:           return 1;
  }
}

/* ----------------------- Cálculo real ----------------------- */
function mm3_to_cm3(v){ return v/1000; }
function kgFromCm3(cm3, density){ return (cm3*density)/1000; }

function computeFromStepJson(stepJson, p){
  if (!stepJson || !stepJson.geometry) throw new Error('Geometria ausente. Carrega um STEP válido.');

  const g = stepJson.geometry;
  const f = mmFactor(g.unit); // para mm

  // dimensões lineares convertidas para mm
  const dims_mm = { x: g.size.x * f, y: g.size.y * f, z: g.size.z * f };
  const bbox_mm3 = dims_mm.x * dims_mm.y * dims_mm.z;

  // volume convertido para mm³
  const part_mm3 = g.volumeApprox * (f**3);

  // volumes em cm³
  const stock_mm3 = bbox_mm3 * (p.globals.stock_factor || 1.05);
  const stock_cm3 = mm3_to_cm3(stock_mm3);
  const part_cm3  = mm3_to_cm3(part_mm3);
  const removal_cm3 = Math.max(0, stock_cm3 - part_cm3);

  // features
  const faces = (stepJson.entities?.ADVANCED_FACE) || 0;
  const holes = (stepJson.entities?.CIRCLE) || 0;

  // tempos (min)
  const setup_min = p.machine.setup_minutes || 0;
  const rough_min = removal_cm3 / (p.material.mrr_rough_cm3_min || 400);
  const finish_min = (faces * (p.globals.seconds_per_face||0.8))/60 + (part_cm3*0.02)/(p.material.mrr_finish_cm3_min||120);
  const drill_min = (holes * (p.globals.seconds_per_hole||3))/60;

  const unit_process_min_pilot  = rough_min + finish_min + drill_min; // por uni, sem setup
  const unit_process_min_series = unit_process_min_pilot * 0.7;       // heurística série

  // custos
  const hourly = p.machine.hourly_rate || 45;
  const mult   = (p.globals.overhead_mult||1.1) * (p.globals.margin_mult||1.15);
  const setup_cost = (setup_min/60) * hourly * mult;

  // custo material (stock)
  const mat_kg = kgFromCm3(stock_cm3, p.material.density_g_cm3||1.0);
  const material_cost = mat_kg * (p.material.cost_per_kg||5);

  const wear = removal_cm3 * (p.globals.wear_per_cm3||0.002);

  const pilot_total_min = setup_min + unit_process_min_pilot;
  const pilot_machine_cost = (pilot_total_min/60) * hourly * mult;
  const pilot_total_cost = pilot_machine_cost + material_cost + wear;

  return {
    diag: { // para o painel
      dims_mm,
      part_cm3,
      removal_cm3,
      faces,
      holes
    },
    times: {
      setup_min,
      rough_min, finish_min, drill_min,
      unit_process_min_pilot,
      unit_process_min_series
    },
    costs: {
      hourly, mult, setup_cost, material_cost, wear,
      pilot_total_cost
    }
  };
}

/* ----------------------- Render resultados ----------------------- */
function renderResults(calc, p){
  state.lastCalc = calc;

  const currency = p.globals.currency;

  // Painel de diagnóstico
  $('#mBBox').textContent = `${calc.diag.dims_mm.x.toFixed(2)} × ${calc.diag.dims_mm.y.toFixed(2)} × ${calc.diag.dims_mm.z.toFixed(2)}`;
  $('#mVolume').textContent = `${fmtNumber(calc.diag.part_cm3)}`;
  $('#mRemoval').textContent = `${fmtNumber(calc.diag.removal_cm3)}`;
  $('#mFaces').textContent = `${calc.diag.faces}`;
  $('#mCircles').textContent = `${calc.diag.holes}`;

  // Sliders display
  $('#sliderFaceVal').textContent = `${Number(p.globals.seconds_per_face).toFixed(1)}s`;
  $('#sliderHoleVal').textContent = `${Number(p.globals.seconds_per_hole).toFixed(1)}s`;

  // Peça Piloto = Q1
  $('#rPilotTime').textContent = fmtMin(calc.times.setup_min + calc.times.unit_process_min_pilot);
  $('#rPilotCost').textContent = fmtMoney(calc.costs.pilot_total_cost, currency);

  // Série
  const host = $('#batchList'); host.innerHTML='';
  const perUnitMin = calc.times.unit_process_min_series; // sem setup
  const pilot_unit_no_setup = Math.max(0, calc.costs.pilot_total_cost - calc.costs.setup_cost);

  p.globals.batches.forEach(q=>{
    const discountPct = getQtyDiscountPct(q, p.globals.discounts); // 0..1
    const unitPrice = pilot_unit_no_setup * (1 - discountPct);
    const totalCost = unitPrice * q + calc.costs.setup_cost + calc.costs.material_cost + calc.costs.wear;
    const totalMin  = perUnitMin * q + calc.times.setup_min;

    const row = document.createElement('div');
    row.className = 'kv';
    row.innerHTML =
      `<span>Q${q}</span>`+
      `<b>`+
        `${fmtMoney(unitPrice, currency)}/uni `+
        `${fmtMoney(totalCost, currency)}/total `+
        ` · `+
        `${fmtMin(perUnitMin)}/uni `+
        `${fmtMin(totalMin)}/total`+
      `</b>`;
    host.appendChild(row);
  });
}

/* ----------------------- Sliders com preview ----------------------- */
function bindDiagSliders(){
  const face = $('#sliderFace');
  const hole = $('#sliderHole');
  face.addEventListener('input', ()=>{
    const v = Number(face.value);
    $('#sliderFaceVal').textContent = `${v.toFixed(1)}s`;
    $('#secPerFace').value = v;
    state.params.globals.seconds_per_face = v;
    if (state.stepJson && !$('#panelResults').classList.contains('hidden')) {
      const calc = computeFromStepJson(state.stepJson, state.params);
      renderResults(calc, state.params);
    }
  });
  hole.addEventListener('input', ()=>{
    const v = Number(hole.value);
    $('#sliderHoleVal').textContent = `${v.toFixed(1)}s`;
    $('#secPerHole').value = v;
    state.params.globals.seconds_per_hole = v;
    if (state.stepJson && !$('#panelResults').classList.contains('hidden')) {
      const calc = computeFromStepJson(state.stepJson, state.params);
      renderResults(calc, state.params);
    }
  });
}

/* ----------------------- Export ----------------------- */
function exportResults(){
  const blob = new Blob([JSON.stringify({
    file: state.fileMeta,
    params: state.params,
    step: state.stepJson,
    calc: state.lastCalc
  }, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'quote_results.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ----------------------- Navegação & Boot ----------------------- */
function bindNav(){
  $('#toParamsBtn').addEventListener('click', ()=> setStep(2));
  $('#backToUploadBtn').addEventListener('click', ()=> setStep(1));
  $('#toResultsBtn').addEventListener('click', ()=>{
    const p = snapshotParams();
    if (!state.stepJson || !state.stepJson.geometry) {
      toast('Carrega um STEP primeiro para calcular a partir da geometria.');
      return;
    }
    setStep(3);
    try{
      const calc = computeFromStepJson(state.stepJson, p);
      renderResults(calc, p);
      toast('Cálculo concluído a partir do STEP.');
    }catch(err){
      console.error(err);
      toast('Falha no cálculo. Ver consola.');
    }
  });
  $('#backToParamsBtn').addEventListener('click', ()=> setStep(2));
  $('#exportBtn').addEventListener('click', exportResults);
  $('#resetBtn').addEventListener('click', ()=>{
    localStorage.removeItem(state.storageKey);
    location.reload();
  });
}

function initParams(){
  fillSelectOptions();
  const stored = loadParamsFromStorage();
  const base = {
    materialKey: Object.keys(SQ_CONFIG.materials)[0],
    machineKey: Object.keys(SQ_CONFIG.machines)[0],
    material: {...SQ_CONFIG.materials[Object.keys(SQ_CONFIG.materials)[0]]},
    machine: {...SQ_CONFIG.machines[Object.keys(SQ_CONFIG.machines)[0]]},
    globals: {...SQ_CONFIG.globals}
  };
  const p = stored || base;

  $('#materialKey').addEventListener('change', e=>{
    const mk = e.target.value; const m = SQ_CONFIG.materials[mk];
    $('#density').value = m.density_g_cm3; $('#costPerKg').value = m.cost_per_kg;
    $('#mrrRough').value = m.mrr_rough_cm3_min; $('#mrrFinish').value = m.mrr_finish_cm3_min;
  });
  $('#machineKey').addEventListener('change', e=>{
    const mk = e.target.value; const m = SQ_CONFIG.machines[mk];
    $('#hourlyRate').value = m.hourly_rate; $('#setupMin').value = m.setup_minutes;
  });

  setFormFromParams(p); state.params = p;
}

function boot(){
  setStep(1);
  bindUpload();
  initParams();
  bindNav();
  bindDiagSliders();
}
document.addEventListener('DOMContentLoaded', boot);
