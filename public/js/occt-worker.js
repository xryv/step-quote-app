/* Web Worker para importar STEP com occt-import-js (WASM) e extrair m?tricas geom?tricas. */

function analyzeMeshes(meshes) {
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
      continue; // esperamos malhas indexadas do OCCT
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

self.onmessage = async (ev) => {
  const { fileBuffer, unit: unitOut = 'millimeter', sourceUnit = null } = ev.data || {};
  try {
    importScripts('/vendor/occt/occt-import-js.js');
    const factory = self.occtimportjs || (typeof occtimportjs !== 'undefined' ? occtimportjs : null);
    if (typeof factory !== 'function') {
      throw new Error('OCCT runtime not found in worker (occtimportjs). Check /vendor/occt/.');
    }

    const occt = await factory();
    const bytes = new Uint8Array(fileBuffer);
    const res = occt.ReadStepFile(bytes, { linearUnit: unitOut });
    if (!res || !res.success) {
      throw new Error('OCCT: failed to read STEP');
    }

    const meshes = Array.isArray(res.meshes) ? res.meshes : [];
    if (!meshes.length) {
      throw new Error('OCCT: no meshes returned');
    }

    const geom = analyzeMeshes(meshes);
    self.postMessage({
      ok: true,
      geometry: {
        unit: unitOut,
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
    });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
