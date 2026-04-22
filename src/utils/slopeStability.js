/**
 * Infinite Slope Stability Model for Landslide Susceptibility
 *
 * Factor of Safety (FoS) = (c' + c_root + (γ·z·cos²β - u) · tan φ') / (γ·z·sin β·cos β)
 *
 * References:
 * - Skempton & DeLory (1957) — Infinite slope stability
 * - Hammond et al. (1992) — Root cohesion from vegetation
 * - Iverson (2000) — Rainfall-triggered landslides
 */

const DEG2RAD = Math.PI / 180;
const GAMMA_W = 9.81; // unit weight of water (kN/m³)

/**
 * WRB soil group → geotechnical parameters
 * Values from literature for tropical/subtropical weathered soils in SE Asia
 *
 * c_base: effective cohesion (kPa) — base value before clay adjustment
 * phi_base: friction angle (degrees) — base value before clay adjustment
 * k: saturated hydraulic conductivity (m/s)
 * z: typical soil depth (m) — regolith thickness
 * porosity: volumetric porosity (0-1)
 */
const WRB_PARAMS = {
  0:  { name: 'Unknown',     c_base: 8,  phi_base: 26, k: 1e-6, z: 1.5, porosity: 0.42 },
  2:  { name: 'Alisol',      c_base: 6,  phi_base: 24, k: 2e-6, z: 1.8, porosity: 0.45 },
  3:  { name: 'Acrisol',     c_base: 8,  phi_base: 26, k: 1e-6, z: 1.5, porosity: 0.42 },
  6:  { name: 'Cambisol',    c_base: 10, phi_base: 28, k: 5e-6, z: 1.2, porosity: 0.40 },
  10: { name: 'Ferralsol',   c_base: 12, phi_base: 28, k: 5e-7, z: 2.0, porosity: 0.48 },
  16: { name: 'Gleysol',     c_base: 4,  phi_base: 20, k: 1e-7, z: 1.0, porosity: 0.50 },
  18: { name: 'Leptosol',    c_base: 15, phi_base: 32, k: 1e-5, z: 0.5, porosity: 0.35 },
  20: { name: 'Luvisol',     c_base: 8,  phi_base: 25, k: 2e-6, z: 1.5, porosity: 0.43 },
  24: { name: 'Plinthosol',  c_base: 7,  phi_base: 24, k: 8e-7, z: 1.8, porosity: 0.44 },
  29: { name: 'Stagnosol',   c_base: 5,  phi_base: 22, k: 5e-8, z: 1.2, porosity: 0.47 },
};

const DEFAULT_PARAMS = WRB_PARAMS[0];

/**
 * Get soil geotechnical parameters adjusted by clay content
 * Higher clay → lower φ', slightly higher c' (clay cohesion)
 */
export function getSoilParams(wrbId, clay05, clay515, bulk05, bulk515) {
  const base = WRB_PARAMS[wrbId] || DEFAULT_PARAMS;

  // Average clay from both depths
  const clay = (typeof clay05 === 'number' && typeof clay515 === 'number')
    ? (clay05 + clay515) / 2
    : (typeof clay05 === 'number' ? clay05 : (typeof clay515 === 'number' ? clay515 : 30));

  // Clay adjustment (reference: 30% clay = neutral)
  // High clay: more cohesion, less friction
  const clayDelta = (clay - 30) / 100;
  const c_prime = Math.max(1, base.c_base + clayDelta * 10);  // ±1 kPa per 10% clay
  const phi_prime = Math.max(15, base.phi_base - clayDelta * 8); // ∓0.8° per 10% clay

  // Unit weight from bulk density (convert g/cm³ to kN/m³)
  const bulk = (typeof bulk05 === 'number' && typeof bulk515 === 'number')
    ? (bulk05 + bulk515) / 2
    : (typeof bulk05 === 'number' ? bulk05 : 1.1);
  const gamma = bulk * 9.81; // kN/m³

  return {
    name: base.name,
    c_prime,      // effective cohesion (kPa)
    phi_prime,    // friction angle (degrees)
    gamma,        // unit weight (kN/m³)
    z: base.z,    // soil depth (m)
    k: base.k,    // permeability (m/s)
    porosity: base.porosity,
    clay,
  };
}

/**
 * Compute root cohesion from NDVI and land cover
 * Dense vegetation → strong root network → higher cohesion
 */
export function getRootCohesion(ndvi, landCover) {
  // Max root cohesion depends on vegetation type (kPa)
  let c_root_max;
  const lc = (landCover || '').toLowerCase();

  if (lc.includes('forest') || lc.includes('wood')) {
    c_root_max = 15; // deep root network
  } else if (lc.includes('scrub') || lc.includes('grass')) {
    c_root_max = 6;  // shallow roots
  } else if (lc.includes('crop') || lc.includes('agriculture')) {
    c_root_max = 3;  // seasonal, weak roots
  } else if (lc.includes('bare') || lc.includes('rock')) {
    c_root_max = 0;
  } else {
    c_root_max = 4;  // default (mixed/urban)
  }

  const ndviVal = (typeof ndvi === 'number') ? Math.max(0, Math.min(1, ndvi)) : 0.3;
  return ndviVal * c_root_max;
}

/**
 * Compute saturation ratio (m) from SMAP, rainfall, and ET
 * m = 0 (completely dry) to 1 (fully saturated)
 */
export function getSaturationRatio(smapMoisture, rain7d, rain15d, etMm8d, soilParams) {
  const { porosity, k, z } = soilParams;

  // Base saturation from SMAP soil moisture
  let m;
  if (typeof smapMoisture === 'number' && smapMoisture > 0) {
    m = Math.min(smapMoisture / porosity, 1.0);
  } else {
    // No SMAP data — estimate from rainfall alone
    m = 0.3; // assume moderate baseline
  }

  // Rainfall infiltration effect (simplified Green-Ampt style)
  // More rain → more water → higher saturation
  const r7 = (typeof rain7d === 'number') ? rain7d : 0;
  const r15 = (typeof rain15d === 'number') ? rain15d : 0;

  // Use weighted combination: recent rain matters more
  const rainEffect = (r7 * 0.6 + r15 * 0.4);
  // Convert mm to volumetric increase in soil column
  const rainIncrease = (rainEffect / 1000) / (z * porosity);
  m += rainIncrease * 0.3; // only ~30% of surface rain infiltrates (rest runs off)

  // ET effect: evapotranspiration removes water
  // ET is mm/8-day composite, convert directly to volumetric fraction
  if (typeof etMm8d === 'number' && etMm8d > 0) {
    const etDecrease = (etMm8d / 1000) / (z * porosity);
    m -= etDecrease;
  }

  return Math.max(0, Math.min(1, m));
}

/**
 * Compute pore water pressure (u) from saturation ratio
 * u = γ_w · m · z · cos²β
 */
export function getPorePressure(m, z, slopeDeg) {
  const beta = slopeDeg * DEG2RAD;
  return GAMMA_W * m * z * Math.cos(beta) * Math.cos(beta);
}

/**
 * Compute Factor of Safety using Infinite Slope Model
 *
 * FoS = (c' + c_root + (γ·z·cos²β - u) · tan φ') / (γ·z·sin β·cos β)
 *
 * Returns: { fos, components }
 */
export function computeFactorOfSafety(params) {
  const {
    slopeDeg,     // slope angle (degrees)
    soilParams,   // from getSoilParams()
    c_root,       // root cohesion (kPa) from getRootCohesion()
    m,            // saturation ratio (0-1) from getSaturationRatio()
  } = params;

  const { c_prime, phi_prime, gamma, z } = soilParams;
  const beta = Math.max(slopeDeg, 0.5) * DEG2RAD; // min 0.5° to avoid division by zero
  const phiRad = phi_prime * DEG2RAD;

  const cosBeta = Math.cos(beta);
  const sinBeta = Math.sin(beta);

  // Pore water pressure
  const u = getPorePressure(m, z, slopeDeg);

  // Normal stress on failure plane
  const normalStress = gamma * z * cosBeta * cosBeta;

  // Effective normal stress
  const effectiveNormal = normalStress - u;

  // Resisting forces (numerator)
  const cohesionTotal = c_prime + c_root;
  const frictionResist = Math.max(0, effectiveNormal) * Math.tan(phiRad);
  const resisting = cohesionTotal + frictionResist;

  // Driving forces (denominator)
  const driving = gamma * z * sinBeta * cosBeta;

  // Factor of Safety
  const fos = driving > 0 ? resisting / driving : 99.9;

  return {
    fos: Math.min(fos, 99.9),
    c_total: cohesionTotal,
    u,
    m,
    effectiveNormal,
    resisting,
    driving,
  };
}

/**
 * Get risk level and color from Factor of Safety
 */
export function getFosRisk(fos) {
  if (fos < 0.8) return { level: 'CRITICAL', color: 'text-fuchsia-600', bgColor: 'bg-fuchsia-50', animate: true };
  if (fos < 1.0) return { level: 'UNSTABLE', color: 'text-rose-600', bgColor: 'bg-rose-50', animate: true };
  if (fos < 1.2) return { level: 'MARGINAL', color: 'text-orange-500', bgColor: 'bg-orange-50', animate: false };
  if (fos < 1.5) return { level: 'MONITOR', color: 'text-yellow-500', bgColor: 'bg-yellow-50', animate: false };
  return { level: 'STABLE', color: 'text-emerald-500', bgColor: 'bg-emerald-50', animate: false };
}

/**
 * Check rainfall threshold alerts
 * Returns array of alert strings (empty if no alerts)
 */
export function checkRainfallAlerts(fos, rainfall, smapMoisture, clay, slopeDeg) {
  const alerts = [];

  if (rainfall) {
    if (rainfall.d7 > 100 && fos < 1.2)
      alerts.push('Active trigger: 7d rain >100mm on weak slope');
    if (rainfall.d15 > 200 && clay > 30)
      alerts.push('Saturated clay: 15d rain >200mm + high clay content');
    if (rainfall.d7 > 150)
      alerts.push('Extreme rainfall: 7d cumulative >150mm');
  }

  if (typeof smapMoisture === 'number' && smapMoisture > 0.35 && slopeDeg > 25)
    alerts.push('High moisture on steep terrain');

  if (fos < 1.0 && slopeDeg > 30)
    alerts.push('Slope failure likely: FoS <1.0 on steep terrain');

  return alerts;
}
