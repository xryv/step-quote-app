// step-quote-app front-end
// ImportaÃ§Ã£o real de STEP -> JSON (header, entidades) + worker OCCT (bbox & volume).
// DiagnÃ³stico (BBox, Volume, RemoÃ§Ã£o, Faces, CÃ­rculos) + sliders live (seg/face, seg/furo).
// PolÃ­tica de preÃ§os: Q1 = peÃ§a piloto; descontos por quantidade (tiers em config).

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const state = {
  file: null,
  fileMeta: null,
  params: null,
  storageKey: 'SQ_PARAMS_V1',
  stepJson: null,    // JSON derivado do STEP
  unitDetected: null,
  lastCalc: null     // cache Ãºltimo cÃ¡lculo (para export)
};

const PARAM_TOOLTIPS = {
  materialKey: 'Escolhe o material base; densidade e custo sao preenchidos automaticamente.',
  density: 'Massa volumetrica usada para calcular stock e custo do material.',
  costPerKg: 'Preco de compra por quilograma do material bruto.',
  mrrRough: 'Taxa media de remocao de material durante o desbaste.',
  mrrFinish: 'Taxa de remocao durante o acabamento leve.',
  machineKey: 'Seleciona o preset de maquina; carrega taxa horaria e setup.',
  hourlyRate: 'Custo hora carregado para operar a maquina, incluindo mao de obra.',
  setupMin: 'Tempo de preparacao antes de produzir o primeiro lote.',
  stockFactor: 'Multiplicador aplicado ao volume da peca para estimar o bloco bruto.',
  secPerFace: 'Segundos extra por face considerados para acabamento ou inspeccao.',
  secPerHole: 'Segundos adicionados por cada furo identificado.',
  wearPerCm3: 'Custo estimado de desgaste de ferramenta por volume removido.',
  overheadMult: 'Multiplicador para custos indiretos como energia e gestao.',
  marginMult: 'Multiplicador de margem comercial aplicado apos custos e overhead.',
  units: 'Unidade usada para interpretar as dimensoes do STEP.',
  currency: 'Moeda utilizada para apresentar os custos calculados.',
  q1: 'Peca piloto; normalmente 1 unidade para validar o setup.',
  q10: 'Segundo patamar de quantidade usado para descontos de serie curta.',
  q50: 'Lote intermedio para prever custos em serie media.',
  q100: 'Lote grande para avaliar descontos e produtividade.'
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

function ensureLabelHead(label){
  let head = label.querySelector('.label-head');
  if (head) return head;
  head = document.createElement('span');
  head.className = 'label-head';
  const labelText = (label.textContent || '').trim();
  while (label.firstChild && label.firstChild.nodeType === Node.TEXT_NODE) {
    const value = (label.firstChild.textContent || '');
    label.removeChild(label.firstChild);
    if (value.trim()) {
      head.appendChild(document.createTextNode(value.trim()));
      break;
    }
  }
  if (!head.textContent) {
    head.appendChild(document.createTextNode(labelText || 'Parametro'));
  }
  label.insertBefore(head, label.firstChild);
  return head;
}

function attachTooltipToInput(id, tip){
  const el = document.getElementById(id);
  if (!el) return;
  const label = el.closest('label');
  if (!label) return;
  const head = ensureLabelHead(label);
  if (head.querySelector('.help-tip')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'help-tip';
  btn.dataset.tip = tip;
  btn.setAttribute('aria-label', tip);
  btn.textContent = '?';
  head.appendChild(btn);
}

function injectParamTooltips(){
  Object.entries(PARAM_TOOLTIPS).forEach(([id, tip]) => attachTooltipToInput(id, tip));
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

const UNIT_LABELS = {
  millimeter: 'mm',
  centimeter: 'cm',
  meter: 'm',
  inch: 'in',
  foot: 'ft'
};

function detectStepLinearUnit(stepText = '') {
  const upper = stepText.toUpperCase();
  if (/\bINCH\b/.test(upper)) return 'inch';
  if (/\bFOOT\b/.test(upper)) return 'foot';
  const siMatch = upper.match(/SI_UNIT\s*\(\s*(\.\w+\.)?\s*,\s*\.METRE\.\s*\)/);
  if (siMatch) {
    const prefix = (siMatch[1] || '').replace(/\./g, '').toLowerCase();
    if (prefix === 'milli') return 'millimeter';
    if (prefix === 'centi') return 'centimeter';
    if (prefix) return 'meter';
    return 'meter';
  }
  if (/\.MILLI\.,\.METRE\./.test(upper)) return 'millimeter';
  if (/\.CENTI\.,\.METRE\./.test(upper)) return 'centimeter';
  if (/\.METRE\./.test(upper)) return 'meter';
  return 'millimeter';
}

function formatUnitLabel(unit) {
  const key = (unit || '').toLowerCase();
  return UNIT_LABELS[key] || key || '--';
}

/* ----------------------- Worker OCCT ----------------------- */
function runOcctWorker(fileBuffer, options = 'millimeter') {
  const opts = typeof options === 'string' ? { linearUnit: options } : (options || {});
  const payload = {
    fileBuffer,
    unit: opts.linearUnit || 'millimeter',
    sourceUnit: opts.sourceUnit || null
  };
  return new Promise((resolve) => {
    const w = new Worker('./js/occt-worker.js');
    w.onmessage = (e) => { resolve(e.data); w.terminate(); };
    w.postMessage(payload);
  });
}
function analyzeOcctMeshes(meshes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let totalVolume = 0;
  let totalArea = 0;
  let openEdgesTotal = 0;
  let foundVertices = false;

  const addEdge = (store, a, b) => {
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    store.set(key, (store.get(key) || 0) + 1);
  };

  for (const mesh of meshes) {
    const positions = mesh?.attributes?.position?.array;
    if (!positions || positions.length < 9) continue;
    foundVertices = true;

    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }

    const indices = mesh?.index?.array;
    if (!indices || indices.length < 3) {
      continue;
    }

    const edgeUse = new Map();
    let meshVolume = 0;
    let meshArea = 0;

    for (let i = 0; i < indices.length; i += 3) {
      const ia = indices[i];
      const ib = indices[i + 1];
      const ic = indices[i + 2];
      if (ia < 0 || ib < 0 || ic < 0) continue;

      const ax = positions[ia * 3];
      const ay = positions[ia * 3 + 1];
      const az = positions[ia * 3 + 2];
      const bx = positions[ib * 3];
      const by = positions[ib * 3 + 1];
      const bz = positions[ib * 3 + 2];
      const cx = positions[ic * 3];
      const cy = positions[ic * 3 + 1];
      const cz = positions[ic * 3 + 2];

      const abx = bx - ax;
      const aby = by - ay;
      const abz = bz - az;
      const acx = cx - ax;
      const acy = cy - ay;
      const acz = cz - az;

      const crossX = aby * acz - abz * acy;
      const crossY = abz * acx - abx * acz;
      const crossZ = abx * acy - aby * acx;
      const triArea = 0.5 * Math.hypot(crossX, crossY, crossZ);
      if (Number.isFinite(triArea)) {
        meshArea += triArea;
      }

      const vol = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      if (Number.isFinite(vol)) {
        meshVolume += vol;
      }

      addEdge(edgeUse, ia, ib);
      addEdge(edgeUse, ib, ic);
      addEdge(edgeUse, ic, ia);
    }

    totalVolume += meshVolume;
    totalArea += meshArea;

    for (const useCount of edgeUse.values()) {
      if (useCount !== 2) {
        openEdgesTotal += 1;
      }
    }
  }

  if (!foundVertices) {
    throw new Error('OCCT: empty meshes in result');
  }

  const size = {
    x: max[0] - min[0],
    y: max[1] - min[1],
    z: max[2] - min[2]
  };

  const warnings = [];
  const isWatertight = openEdgesTotal === 0;
  if (!isWatertight) {
    warnings.push('mesh_not_watertight');
  }

  return {
    min,
    max,
    size,
    volume: Math.abs(totalVolume),
    area: totalArea,
    openEdges: openEdgesTotal,
    isWatertight,
    warnings
  };
}


// Fallback: se o worker falhar, carregamos o OCCT no main thread via <script> UMD
async function computeGeometryInMainThread(fileBuffer, options = 'millimeter') {
  const linearUnit = typeof options === 'string' ? options : (options.linearUnit || 'millimeter');
  const sourceUnit = typeof options === 'string' ? null : (options.sourceUnit || null);
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
  const res = occt.ReadStepFile(bytes, { linearUnit });
  if (!res || !res.success) throw new Error('OCCT(ReadStepFile) failed in main thread.');

  const meshes = Array.isArray(res.meshes) ? res.meshes : [];
  if (!meshes.length) throw new Error('OCCT: no meshes');

  const geom = analyzeOcctMeshes(meshes);
  return {
    ok: true,
    geometry: {
      unit: linearUnit,
      sourceUnit,
      bbox: { min: geom.min, max: geom.max },
      size: geom.size,
      volumeMm3: geom.volume,
      surfaceAreaMm2: geom.area,
      isWatertight: geom.isWatertight,
      openEdgeCount: geom.openEdges,
      meshCount: meshes.length,
      warnings: geom.warnings
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
    if(!/\.(step|stp)$/i.test(f.name)){ toast('Ficheiro inv?lido. Use .step ou .stp'); return; }

    state.file = f;
    state.fileMeta = { name: f.name, size: f.size, date: new Date(f.lastModified).toLocaleString('pt-PT') };
    $('#fiName').textContent = state.fileMeta.name;
    $('#fiSize').textContent = humanSize(state.fileMeta.size);
    $('#fiDate').textContent = state.fileMeta.date;
    const unitCell = $('#fiUnit');
    if (unitCell) unitCell.textContent = '--';
    $('#fileInfo').classList.remove('hidden');
    $('#toParamsBtn').disabled = true;

    toast('A processar STEP...');

    const [text, buffer] = await Promise.all([ f.text(), f.arrayBuffer() ]);

    const detectedUnit = detectStepLinearUnit(text);
    state.unitDetected = detectedUnit;
    if (unitCell) unitCell.textContent = formatUnitLabel(detectedUnit);

    if (state.params?.globals) {
      state.params.globals.units = detectedUnit;
      const unitsSelect = $('#units');
      if (unitsSelect) {
        unitsSelect.value = detectedUnit;
      }
      saveParamsToStorage();
    }

    const header = parseHeader(text);
    const entities = parseEntities(text);
    const totalEntities = Object.values(entities).reduce((a,b)=>a+b,0);

    const occtUnit = 'millimeter';
    let occt = await runOcctWorker(buffer, { linearUnit: occtUnit, sourceUnit: detectedUnit });

    if (!occt.ok) {
      console.warn('OCCT worker falhou:', occt.error);
      toast('Worker falhou. A calcular no proprio browser...');
      try {
        occt = await computeGeometryInMainThread(buffer, { linearUnit: occtUnit, sourceUnit: detectedUnit });
      } catch (e) {
        console.error('Fallback OCCT falhou:', e);
        occt = { ok: false, error: e };
      }
    }

    state.stepJson = {
      tool: 'in-app-step2json',
      version: '0.1.0',
      file: { name: f.name, sizeBytes: f.size },
      header,
      summary: { totalEntities, uniqueTypes: Object.keys(entities).length },
      meta: { detectedUnit, occtUnit },
      entities,
      geometry: occt.ok ? occt.geometry : undefined
    };

    if (!occt.ok) {
      toast('Falha ao processar geometria. Ver consola.');
      return;
    }

    if (occt.geometry?.warnings?.length) {
      console.warn('OCCT geometry warnings:', occt.geometry.warnings);
    }

    $('#toParamsBtn').disabled = false;
    const unitLabel = formatUnitLabel(detectedUnit) || detectedUnit || 'mm';
    toast(occt.geometry?.warnings?.length
      ? `STEP processado com avisos (${unitLabel}). Verifica o modelo antes de calcular.`
      : `STEP processado. Unidade detectada: ${unitLabel}.`);
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
      finish_allowance_mm: state.params?.globals?.finish_allowance_mm ?? SQ_CONFIG.globals.finish_allowance_mm ?? 0.2,
      series_gain: state.params?.globals?.series_gain ?? SQ_CONFIG.globals.series_gain ?? 0.7,
      discounts: SQ_CONFIG.globals.discounts || []
    }
  };
  state.params = p; saveParamsToStorage(); return p;
}

/* ----------------------- FormataÃ§Ã£o ----------------------- */
const CURRENCY_SYMBOLS = { EUR: '\u20AC', USD: '$', GBP: '\u00A3' };
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

/* ----------------------- CÃ¡lculo real ----------------------- */
function mm3_to_cm3(v){ return v/1000; }
const mm2_to_cm2 = v => v/100;
function kgFromCm3(cm3, density){ return (cm3*density)/1000; }

function computeFromStepJson(stepJson, p){
  if (!stepJson || !stepJson.geometry) throw new Error('Geometria ausente. Carrega um STEP v?lido.');

  const g = stepJson.geometry;
  if (!Number.isFinite(g.volumeMm3) || g.volumeMm3 <= 0) {
    throw new Error('Geometria inv?lida: volume nulo ou indefinido.');
  }

  const mmScale = mmFactor(g.unit);
  const dims_mm = { x: g.size.x * mmScale, y: g.size.y * mmScale, z: g.size.z * mmScale };

  const stockFactor = Math.max(1, p.globals.stock_factor || 1.05);
  const linearStockFactor = Math.cbrt(stockFactor);
  const stock_dims_mm = {
    x: dims_mm.x * linearStockFactor,
    y: dims_mm.y * linearStockFactor,
    z: dims_mm.z * linearStockFactor
  };
  const stock_mm3 = stock_dims_mm.x * stock_dims_mm.y * stock_dims_mm.z;
  const part_mm3 = (g.volumeMm3 || 0) * Math.pow(mmScale, 3);

  const stock_cm3 = mm3_to_cm3(stock_mm3);
  const part_cm3 = mm3_to_cm3(part_mm3);
  const removal_cm3 = Math.max(0, stock_cm3 - part_cm3);

  const surface_mm2 = (g.surfaceAreaMm2 || 0) * Math.pow(mmScale, 2);
  const surface_area_cm2 = mm2_to_cm2(surface_mm2);

  const faces = stepJson.entities?.ADVANCED_FACE || 0;
  const holes = stepJson.entities?.CIRCLE || 0;

  const setup_min = p.machine.setup_minutes || 0;
  const seconds_per_face = p.globals.seconds_per_face || 0;
  const seconds_per_hole = p.globals.seconds_per_hole || 0;
  const finishAllowance = Number.isFinite(p.globals.finish_allowance_mm) ? Math.max(0, p.globals.finish_allowance_mm) : 0.2;

  const finish_volume_mm3 = Math.max(0, surface_mm2 * finishAllowance);
  const finish_volume_cm3 = mm3_to_cm3(finish_volume_mm3);
  const rough_volume_cm3 = Math.max(0, removal_cm3 - finish_volume_cm3);

  const rough_min = rough_volume_cm3 / (p.material.mrr_rough_cm3_min || 400);
  const finish_min = (finish_volume_cm3 / (p.material.mrr_finish_cm3_min || 120)) + ((faces * seconds_per_face) / 60);
  const drill_min = (holes * seconds_per_hole) / 60;

  const unit_process_min_pilot = rough_min + finish_min + drill_min;
  const seriesGain = Number.isFinite(p.globals.series_gain) && p.globals.series_gain > 0
    ? Math.min(Math.max(p.globals.series_gain, 0.3), 1)
    : 0.7;
  const unit_process_min_series = unit_process_min_pilot * seriesGain;

  const hourly = p.machine.hourly_rate || 45;
  const overheadMult = p.globals.overhead_mult || 1.1;
  const marginMult = p.globals.margin_mult || 1.15;
  const wearRate = p.globals.wear_per_cm3 || 0.002;

  const wear_cost_nomargin = removal_cm3 * wearRate;
  const mat_kg = kgFromCm3(stock_cm3, p.material.density_g_cm3 || 1.0);
  const material_cost_nomargin = mat_kg * (p.material.cost_per_kg || 5);

  const base_setup_cost = (setup_min / 60) * hourly;
  const base_cycle_cost = (unit_process_min_pilot / 60) * hourly;
  const setup_cost_overhead = base_setup_cost * overheadMult;
  const cycle_cost_overhead = base_cycle_cost * overheadMult;

  const per_unit_cost_before_margin = cycle_cost_overhead + wear_cost_nomargin + material_cost_nomargin;
  const per_unit_cost_with_margin = per_unit_cost_before_margin * marginMult;
  const setup_cost_with_margin = setup_cost_overhead * marginMult;
  const pilot_total_cost = (setup_cost_overhead + per_unit_cost_before_margin) * marginMult;

  return {
    diag: {
      dims_mm,
      stock_dims_mm,
      part_cm3,
      stock_cm3,
      removal_cm3,
      surface_area_cm2,
      faces,
      holes,
      sourceUnit: g.sourceUnit || g.unit,
      isWatertight: g.isWatertight,
      warnings: g.warnings || []
    },
    times: {
      setup_min,
      rough_min, finish_min, drill_min,
      unit_process_min_pilot,
      unit_process_min_series,
      series_gain: seriesGain
    },
    costs: {
      hourly,
      overhead_mult: overheadMult,
      margin_mult: marginMult,
      base_setup_cost,
      base_cycle_cost,
      setup_cost_overhead,
      cycle_cost_overhead,
      setup_cost_with_margin,
      per_unit_cost_before_margin,
      per_unit_cost_with_margin,
      wear_cost_nomargin,
      material_cost_nomargin,
      pilot_total_cost
    }
  };
}

/* ----------------------- Render resultados ----------------------- */
function renderResults(calc, p){
  state.lastCalc = calc;

  const currency = p.globals.currency;

  $('#mBBox').textContent = `${calc.diag.dims_mm.x.toFixed(2)} | ${calc.diag.dims_mm.y.toFixed(2)} | ${calc.diag.dims_mm.z.toFixed(2)}`;
  $('#mVolume').textContent = `${fmtNumber(calc.diag.part_cm3)}`;
  $('#mRemoval').textContent = `${fmtNumber(calc.diag.removal_cm3)}`;
  $('#mFaces').textContent = `${calc.diag.faces}`;
  $('#mCircles').textContent = `${calc.diag.holes}`;

  $('#sliderFaceVal').textContent = `${Number(p.globals.seconds_per_face).toFixed(1)}s`;
  $('#sliderHoleVal').textContent = `${Number(p.globals.seconds_per_hole).toFixed(1)}s`;

  $('#rPilotTime').textContent = fmtMin(calc.times.setup_min + calc.times.unit_process_min_pilot);
  $('#rPilotCost').textContent = fmtMoney(calc.costs.pilot_total_cost, currency);

  const host = $('#batchList'); host.innerHTML='';
  const perUnitMin = calc.times.unit_process_min_series;
  const perUnitCost = calc.costs.per_unit_cost_with_margin;
  const setupCost = calc.costs.setup_cost_with_margin;

  (p.globals.batches || []).filter(q => Number.isFinite(q) && q > 0).forEach(q => {
    const discountPct = getQtyDiscountPct(q, p.globals.discounts);
    const unitPrice = perUnitCost * (1 - discountPct);
    const totalCost = unitPrice * q + setupCost;
    const totalMin = perUnitMin * q + calc.times.setup_min;

    const row = document.createElement('div');
    row.className = 'kv';
    row.innerHTML =
      `<span>Q${q}</span>` +
      `<b>` +
        `${fmtMoney(unitPrice, currency)}/uni ` +
        `${fmtMoney(totalCost, currency)}/total ` +
        ` | ` +
        `${fmtMin(perUnitMin)}/uni ` +
        `${fmtMin(totalMin)}/total` +
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

/* ----------------------- NavegaÃ§Ã£o & Boot ----------------------- */
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
      toast('CÃ¡lculo concluÃ­do a partir do STEP.');
    }catch(err){
      console.error(err);
      toast('Falha no cÃ¡lculo. Ver consola.');
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
  if (p.globals.finish_allowance_mm == null) {
    p.globals.finish_allowance_mm = SQ_CONFIG.globals.finish_allowance_mm ?? 0.2;
  }
  if (p.globals.series_gain == null) {
    p.globals.series_gain = SQ_CONFIG.globals.series_gain ?? 0.7;
  }

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
  injectParamTooltips();
  bindNav();
  bindDiagSliders();
}
document.addEventListener('DOMContentLoaded', boot);
