// Defaults & options (podes ajustar livremente)
window.SQ_CONFIG = {
  materials: {
    ALU_2017: { name: "Alumínio 2017", density_g_cm3: 2.80, cost_per_kg: 6.5, mrr_rough_cm3_min: 600, mrr_finish_cm3_min: 120 },
    PEEK:      { name: "PEEK",          density_g_cm3: 1.30, cost_per_kg: 55,  mrr_rough_cm3_min: 900, mrr_finish_cm3_min: 250 },
    STEEL_42:  { name: "42CrMo4",       density_g_cm3: 7.85, cost_per_kg: 2.2, mrr_rough_cm3_min: 250, mrr_finish_cm3_min: 80 }
  },
  machines: {
    VMC_3AX: { name: "Centro 3 Eixos", hourly_rate: 45, setup_minutes: 20 },
    HSC_3AX: { name: "Centro HSC",     hourly_rate: 65, setup_minutes: 15 },
    TURN_2AX:{ name: "Torno 2 Eixos",  hourly_rate: 40, setup_minutes: 15 }
  },
  globals: {
    currency: "EUR",
    units: "millimeter",
    stock_factor: 1.05,
    seconds_per_face: 0.8,
    seconds_per_hole: 3,
    wear_per_cm3: 0.002,
    overhead_mult: 1.12,
    margin_mult: 1.18,
    batches: [1, 10, 50, 100],

    // 🔽 NOVO: descontos por quantidade (aplicados ao preço unit/sem setup)
    // policy: usa o maior "minQty" ≤ quantidade pedida
    discounts: [
      { minQty: 1,   pct: 0.00 }, // Q1 = Peça Piloto
      { minQty: 10,  pct: 0.05 }, // Q10 = -5%
      { minQty: 50,  pct: 0.10 }, // Q50 = -10%
      { minQty: 100, pct: 0.20 }  // Q100 = -20%
    ]
  }
};
