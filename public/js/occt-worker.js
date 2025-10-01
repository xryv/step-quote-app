/* Web Worker para importar STEP com occt-import-js (WASM) e calcular bbox/volume. */
self.onmessage = async (ev) => {
  const { fileBuffer, unit } = ev.data;
  try {
    // Carrega o runtime OCCT servido localmente
    importScripts('/vendor/occt/occt-import-js.js');

    // UMD expõe uma função global chamada 'occtimportjs'.
    // Dependendo do bundle, pode ficar em self.occtimportjs ou occtimportjs.
    const factory = (self.occtimportjs || (typeof occtimportjs !== 'undefined' ? occtimportjs : null));
    if (typeof factory !== 'function') {
      throw new Error('OCCT runtime not found in worker (occtimportjs). Check /vendor/occt/ path.');
    }

    const occt = await factory(); // inicializa WASM
    const bytes = new Uint8Array(fileBuffer);

    // Nota: o .wasm deve estar no MESMO diretório que o .js (dist/), e é servido por /vendor/occt/
    const res = occt.ReadStepFile(bytes, { linearUnit: unit || 'millimeter' });
    if (!res || !res.success) throw new Error('OCCT: failed to read STEP');

    const meshes = res.meshes || [];
    if (!meshes.length) throw new Error('OCCT: no meshes returned');

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
        approxVolume += (ax*(by*cz - bz*cy) - ay*(bx*cz - bz*cx) + az*(bx*cy - by*cx)) / 6.0;
      }
    }
    approxVolume = Math.abs(approxVolume);

    const size = [ max[0]-min[0], max[1]-min[1], max[2]-min[2] ];

    self.postMessage({
      ok: true,
      geometry: {
        unit: (unit || 'millimeter'),
        bbox: { min, max },
        size: { x: size[0], y: size[1], z: size[2] },
        volumeApprox: approxVolume
      }
    });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
