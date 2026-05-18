import React, { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { isValidGrid, calculateSlope, calculateAspect, calculateTRI, calculateCurvature, calculateTPI } from './utils/terrainMath';
import { getSoilParams, getRootCohesion, getSaturationRatio, computeFactorOfSafety, getFosRisk, checkRainfallAlerts } from './utils/slopeStability';
import * as turf from '@turf/turf';
import throttle from 'lodash.throttle';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;
const API_BASE = import.meta.env.VITE_API_URL || '';

const fmtBytes = (bytes) => {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
};

// Dữ liệu ranh giới Lào Cai chi tiết
const laoCaiBoundary = {
  "type": "Feature",
  "geometry": {
    "type": "MultiPolygon",
    "coordinates": [[[[104.424416, 22.572268], [104.413803, 22.529243], [104.472832, 22.484758], [104.455109, 22.440964], [104.581223, 22.348581], [104.548012, 22.250629], [104.627815, 22.219328], [104.625565, 22.172234], [104.582794, 22.177116], [104.561401, 22.086498], [104.452667, 22.185892], [104.415642, 22.20043], [104.383705, 22.175978], [104.405586, 22.116943], [104.374886, 22.069012], [104.414055, 22.028339], [104.431366, 21.94586], [104.352959, 21.875256], [104.283142, 21.940296], [104.211182, 21.949257], [104.230118, 21.902557], [104.194733, 21.887682], [103.996407, 21.92717], [103.957855, 21.999224], [103.939636, 22.138029], [103.869225, 22.176432], [103.827515, 22.267233], [103.763275, 22.311281], [103.783562, 22.338146], [103.766594, 22.39118], [103.731339, 22.41464], [103.607483, 22.407785], [103.556557, 22.469774], [103.595444, 22.528435], [103.574677, 22.578926], [103.531601, 22.594933], [103.579979, 22.66271], [103.566368, 22.704861], [103.640602, 22.796249], [103.876251, 22.564993], [103.978653, 22.50655], [104.011223, 22.52095], [104.045807, 22.734301], [104.113792, 22.811098], [104.258308, 22.84407], [104.27755, 22.83964], [104.268837, 22.74024], [104.334953, 22.72175], [104.335289, 22.68856], [104.396942, 22.679234], [104.461693, 22.61252], [104.462845, 22.571753], [104.424416, 22.572268]]]]
  },
  "properties": { "name": "Lào Cai" }
};

const LAO_CAI_BOUNDS = [
  [102.8, 21.5], // Southwest
  [105.2, 23.3]  // Northeast
];

// Các lớp dữ liệu thô từ Mapbox Outdoors
const TARGET_LAYERS = {
  roads: ['road-motorway-trunk', 'road-primary', 'road-secondary-tertiary', 'road-street', 'road-minor', 'path-pedestrian'],
  water: ['waterway', 'water'],
  landcover: ['landcover', 'landuse', 'natural', 'building']
};

// Hàm chuyển đổi góc phương vị (Aspect) sang Hướng (Cardinal Direction)
const getCardinalDirection = (degree) => {
  if (degree < 0) return 'Flat';
  if (degree >= 337.5 || degree < 22.5) return 'N';
  if (degree >= 22.5 && degree < 67.5) return 'NE';
  if (degree >= 67.5 && degree < 112.5) return 'E';
  if (degree >= 112.5 && degree < 157.5) return 'SE';
  if (degree >= 157.5 && degree < 202.5) return 'S';
  if (degree >= 202.5 && degree < 247.5) return 'SW';
  if (degree >= 247.5 && degree < 292.5) return 'W';
  if (degree >= 292.5 && degree < 337.5) return 'NW';
  return 'Unknown';
};

// --- PURE FUNCTION FOR BATCH EXTRACTION ---
const extractDataForPoint = (lng, lat, mapInstance, prefetchedFeatures = null) => {
  // SNAPPING NGAY LẬP TỨC: Khóa tọa độ về độ chính xác 10cm để triệt tiêu fluctuation
  const sLng = Number((((lng + 180) % 360 + 360) % 360 - 180).toFixed(6));
  const sLat = Number(lat.toFixed(6));
  const pt = turf.point([sLng, sLat]);

  const point = mapInstance.project([sLng, sLat]);

  // Bounding box nhỏ (4x4 pixel) cho điểm trung tâm để tránh trượt
  const exactBbox = [
    [point.x - 2, point.y - 2],
    [point.x + 2, point.y + 2]
  ];

  // Tính khoảng cách tìm kiếm vector
  const searchRadiusPx = 100;
  const bbox = [
    [point.x - searchRadiusPx, point.y - searchRadiusPx],
    [point.x + searchRadiusPx, point.y + searchRadiusPx]
  ];

  // Các lớp dữ liệu xung quanh và tại vị trí chuột
  const nearbyFeatures = mapInstance.queryRenderedFeatures(bbox);
  const exactFeatures = mapInstance.queryRenderedFeatures(exactBbox);

  // QUERY ELEVATION TỪ TỌA ĐỘ ĐÃ SNAPPED
  const elevation = mapInstance.queryTerrainElevation([sLng, sLat]);

  // Khởi tạo biến
  let slopeVal = 'N/A';
  let aspectVal = 'N/A';
  let triVal = 'N/A';
  let tpiVal = 'N/A';
  let tpiClass = 'Flat';
  let convergenceWarning = false;
  let curvatureVal = 'N/A';
  let riskLevel = 'Unknown';
  let riskColor = 'text-slate-500';
  let lsiVal = 'N/A';
  let lsiColor = 'text-slate-500';
  let slopeNum = 0;

  if (elevation !== null) {
    // THE NUCLEAR OPTION: PIXEL-BASED SAMPLING ENGINE
    const scales = [5, 10]; // in meters
    let totalDzDx = 0;
    let totalDzDy = 0;
    let grid5 = null;

    const zoom = mapInstance.getZoom();
    const mpp = 156543.03392 * Math.cos(sLat * Math.PI / 180) / Math.pow(2, zoom);

    scales.forEach(step => {
      const offsetPx = step / mpp;
      const dx = offsetPx * mpp;
      const dy = offsetPx * mpp;

      const getElev = (px, py) => {
        const ll = mapInstance.unproject([point.x + px, point.y + py]);
        return mapInstance.queryTerrainElevation([ll.lng, ll.lat]);
      };

      const g = [
        getElev(-offsetPx, -offsetPx), getElev(0, -offsetPx), getElev(offsetPx, -offsetPx),
        getElev(-offsetPx, 0), elevation, getElev(offsetPx, 0),
        getElev(-offsetPx, offsetPx), getElev(0, offsetPx), getElev(offsetPx, offsetPx)
      ];

      if (isValidGrid(g)) {
        const gradX = ((g[2] + 2 * g[5] + g[8]) - (g[0] + 2 * g[3] + g[6])) / (8 * dx);
        const gradY = ((g[0] + 2 * g[1] + g[2]) - (g[6] + 2 * g[7] + g[8])) / (8 * dy);
        totalDzDx += gradX;
        totalDzDy += gradY;
        if (step === 5) grid5 = g;
      }
    });

    const avgDzDx = totalDzDx / scales.length;
    const avgDzDy = totalDzDy / scales.length;

    const slope = calculateSlope(avgDzDx, avgDzDy);
    const aspect = calculateAspect(avgDzDx, avgDzDy);      
    slopeVal = slope.toFixed(1);
    slopeNum = slope;
    aspectVal = aspect === -1 ? 'Flat' : `${Math.round(aspect)}° (${getCardinalDirection(aspect)})`;

    if (slope < 15) { riskLevel = 'Safe'; riskColor = 'text-emerald-500'; }
    else if (slope < 30) { riskLevel = 'Monitor'; riskColor = 'text-yellow-500'; }
    else if (slope < 45) { riskLevel = 'High Risk'; riskColor = 'text-orange-500'; }
    else { riskLevel = 'Extreme Risk'; riskColor = 'text-rose-600'; }

    if (grid5 && isValidGrid(grid5)) {
      triVal = calculateTRI(grid5).toFixed(2);
      curvatureVal = calculateCurvature(grid5, 5, 5).toFixed(2);
      const tpiRaw = calculateTPI(grid5);
      tpiVal = tpiRaw.toFixed(2);
      if (tpiRaw > 0.5) tpiClass = 'Ridge';
      else if (tpiRaw < -0.5) tpiClass = 'Valley';
      if (tpiRaw < -0.5 && parseFloat(curvatureVal) < -0.5) convergenceWarning = true;
    } else {
      triVal = '0.00'; curvatureVal = '0.00';
    }
  }

  let isZoomValid = mapInstance.getZoom() >= 14;

  let landCover = 'Unknown';
  let armorScore = 0.5;
  let armorLabel = 'Average Cover';
  let isResidential = false;

  let minRoadDist = Infinity;
  let minWaterDist = Infinity;
  let fragmentationCount = 0;

  if (isZoomValid) {
    let isWaterBody = false;

    exactFeatures.forEach(f => {
      const sl = f.sourceLayer || (f.layer && f.layer['source-layer']);
      if (sl && TARGET_LAYERS.water.includes(sl)) isWaterBody = true;

      if (sl && TARGET_LAYERS.landcover.includes(sl)) {
        let lcClass = f.properties.class || f.properties.type || 'Unknown';
        if (sl === 'building') lcClass = 'building';

        if (lcClass !== 'Unknown') {
          landCover = lcClass;
          if (['forest', 'wood'].includes(lcClass)) { armorScore = 0.1; armorLabel = 'Dense Canopy'; }
          else if (['scrub', 'grass', 'pitch', 'park'].includes(lcClass)) { armorScore = 0.5; armorLabel = 'Shallow Roots'; }
          else if (['crop', 'agriculture'].includes(lcClass)) { armorScore = 0.6; armorLabel = 'Disturbed Soil'; }
          else if (['bare_earth', 'construction', 'quarry', 'sand', 'rock'].includes(lcClass)) { armorScore = 1.0; armorLabel = 'Exposed Surface'; }
          else if (['residential', 'commercial', 'industrial', 'settlement', 'urban', 'building'].includes(lcClass)) {
            armorScore = 0.8; armorLabel = 'Urban Surcharge'; isResidential = true;
          } else {
            armorLabel = `Unknown (${lcClass})`;
          }
        }
      }
    });

    if (landCover === 'Unknown' && !isWaterBody && elevation !== null) {
        landCover = 'bare_rock (inferred)'; armorScore = 1.0; armorLabel = 'Exposed Bedrock / Scree';
    } else if (landCover === 'Unknown' && isWaterBody) {
        landCover = 'water'; armorScore = 0.0; armorLabel = 'Water Body';
    }

    if (['forest', 'wood'].includes(landCover) && slopeNum > 45) {
      armorScore += 0.2; armorLabel = 'Forest Limit Reached (>45°)';
    }

    nearbyFeatures.forEach(f => {
      try {
        const sl = f.sourceLayer || (f.layer && f.layer['source-layer']);
        if (sl && TARGET_LAYERS.landcover.includes(sl)) {
            const lc = f.properties.class || f.properties.type;
            if (['bare_earth', 'construction', 'quarry'].includes(lc)) fragmentationCount++;
        }
      } catch { }
    });

    // TỐI ƯU HÓA DISTANCE: Chỉ quét trên danh sách đã lọc sẵn nếu ở chế độ Batch
    const roadsToCheck = prefetchedFeatures?.roads || nearbyFeatures.filter(f => f.layer && TARGET_LAYERS.roads.includes(f.layer.id));
    const waterToCheck = prefetchedFeatures?.water || nearbyFeatures.filter(f => {
        const sl = f.sourceLayer || (f.layer && f.layer['source-layer']);
        return sl && TARGET_LAYERS.water.includes(sl);
    });

    roadsToCheck.forEach(f => {
      try {
        if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
          const dist = turf.pointToLineDistance(pt, f, { units: 'meters' });
          if (dist < minRoadDist) minRoadDist = dist;
        } else if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
          if (turf.booleanPointInPolygon(pt, f)) minRoadDist = 0;
        }
      } catch { }
    });

    waterToCheck.forEach(f => {
      try {
        if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
          const dist = turf.pointToLineDistance(pt, f, { units: 'meters' });
          if (dist < minWaterDist) minWaterDist = dist;
        } else if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
          if (turf.booleanPointInPolygon(pt, f)) minWaterDist = 0;
          else {
            const centroid = turf.centroid(f);
            const dist = turf.distance(pt, centroid, { units: 'meters' });
            if (dist < minWaterDist) minWaterDist = dist;
          }
        }
      } catch { }
    });

    if (['forest', 'wood'].includes(landCover) && fragmentationCount >= 3) {
        armorScore += 0.15; armorLabel = 'Fragmented Canopy';
    }
  } else {
    landCover = 'Zoom in to load';
    armorLabel = 'Zoom in to load';
  }

  armorScore = Math.min(armorScore, 1.0);

  const distRoadStr = isZoomValid ? (minRoadDist === Infinity ? 'Off-screen' : Math.round(minRoadDist) + 'm') : 'Zoom in to load';
  const distWaterStr = isZoomValid ? (minWaterDist === Infinity ? 'Off-screen' : Math.round(minWaterDist) + 'm') : 'Zoom in to load';

  const tpiRawNum = parseFloat(tpiVal);

  // ========== QUERY ALL DATA SOURCES ==========

  // SOIL
  let soilClay05 = 'N/A', soilClay515 = 'N/A';
  let soilBulk05 = 'N/A', soilBulk515 = 'N/A';
  let soilWrb = 'N/A';
  const soilFeatures = mapInstance.queryRenderedFeatures(exactBbox, { layers: ['soil-fill'] });
  if (soilFeatures.length > 0) {
    const sp = soilFeatures[0].properties;
    soilClay05 = sp.clay_0_5; soilClay515 = sp.clay_5_15;
    soilBulk05 = sp.bulk_0_5; soilBulk515 = sp.bulk_5_15;
    soilWrb = sp.wrb_id;
  }

  // SMAP
  let smapData = null;
  const smapFeatures = mapInstance.queryRenderedFeatures(exactBbox, { layers: ['smap-fill'] });
  if (smapFeatures.length > 0) {
    const s = smapFeatures[0].properties;
    smapData = { mean: s.sm_mean, latest: s.sm_latest, max: s.sm_max };
  }

  // NDVI
  let ndviData = null;
  const ndviFeatures = mapInstance.queryRenderedFeatures(exactBbox, { layers: ['ndvi-fill'] });
  if (ndviFeatures.length > 0) { ndviData = { ndvi: ndviFeatures[0].properties.ndvi }; }

  // ET
  let etData = null;
  const etFeatures = mapInstance.queryRenderedFeatures(exactBbox, { layers: ['et-fill'] });
  if (etFeatures.length > 0) { etData = { et: etFeatures[0].properties.et }; }

  // RAINFALL
  let rainfall = null;
  const rfFeatures = mapInstance.queryRenderedFeatures(exactBbox, { layers: ['rainfall-fill'] });
  if (rfFeatures.length > 0) {
    const rf = rfFeatures[0].properties;
    rainfall = { today: rf.rain_today, d3: rf.rain_3d, d7: rf.rain_7d, d15: rf.rain_15d, d30: rf.rain_30d, max: rf.rain_max, mean: rf.rain_mean, wetDays: rf.wet_days, date: rf.date };
  }

  // SLOPE UNIT
  let slopeUnit = null;
  const suFeatures = mapInstance.queryRenderedFeatures(exactBbox, { layers: ['slope-units-fill'] });
  if (suFeatures.length > 0) {
    const su = suFeatures[0].properties;
    slopeUnit = { meanSlope: su.mean_slope, maxSlope: su.max_slope, meanElev: su.mean_elev, elevRange: su.elev_range, areaKm2: su.area_km2, flowAcc: su.flow_acc };
  }

  // ========== INFINITE SLOPE FACTOR OF SAFETY ==========

  // Missing-input audit: any null/N-A source means FOS would be computed on fallback defaults.
  // The sidebar uses this list to decide whether to show the real number or a placeholder.
  const missingInputs = [];
  if (typeof soilWrb !== 'number') missingInputs.push('Soil');
  if (!ndviData) missingInputs.push('NDVI');
  if (!rainfall) missingInputs.push('Rainfall');
  if (!smapData) missingInputs.push('SMAP');
  if (!etData) missingInputs.push('ET');

  let fosResult = null;
  let soilParams = null;
  let c_root = null;
  let m = null;
  let alerts = [];

  if (missingInputs.length === 0) {
    // Phase 1: Soil parameters
    soilParams = getSoilParams(soilWrb, soilClay05, soilClay515, soilBulk05, soilBulk515);

    // Phase 3: Root cohesion from NDVI + land cover
    c_root = getRootCohesion(ndviData.ndvi, landCover);

    // Phase 2+4: Saturation ratio from SMAP + rainfall + ET
    m = getSaturationRatio(smapData.mean, rainfall.d7, rainfall.d15, etData.et, soilParams);

    // Phase 5: Factor of Safety
    fosResult = computeFactorOfSafety({ slopeDeg: slopeNum, soilParams, c_root, m });
    const fosRisk = getFosRisk(fosResult.fos);

    lsiVal = fosResult.fos.toFixed(2);
    lsiColor = fosRisk.color;
    riskLevel = fosRisk.level;
    riskColor = fosRisk.color + (fosRisk.animate ? ' animate-pulse' : '');

    // Phase 6: Rainfall threshold alerts
    alerts = checkRainfallAlerts(fosResult.fos, rainfall, smapData.mean, soilParams.clay, slopeNum);
  }

  return {
    lngLat: [sLng.toFixed(4), sLat.toFixed(4)],
    elevation: elevation !== null ? Math.round(elevation) : 'N/A',
    slope: slopeVal,
    aspect: aspectVal,
    tri: triVal,
    tpi: tpiVal,
    tpiClass: tpiClass,
    convergenceWarning: convergenceWarning,
    curvature: curvatureVal,
    riskLevel: riskLevel,
    riskColor: riskColor,
    lsi: lsiVal,
    lsiColor: lsiColor,
    fos: fosResult?.fos ?? null,
    fosComponents: fosResult,
    soilParams: soilParams,
    saturation: m,
    rootCohesion: c_root,
    alerts: alerts,
    missingInputs,
    landCover: landCover,
    armorScore: armorScore,
    armorLabel: armorLabel,
    distRoad: distRoadStr,
    distWater: distWaterStr,
    zoomWarning: !isZoomValid,
    soilClay05, soilClay515, soilBulk05, soilBulk515, soilWrb,
    slopeUnit, rainfall, smap: smapData, ndvi: ndviData, et: etData
  };
};

const App = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const searchMarker = useRef(null);
  const nasaPopup = useRef(null);
  
  // Toggles hiển thị
  const [showRoads, setShowRoads] = useState(false);
  const [showWater, setShowWater] = useState(false);
  
  // Soil layer controls
  const [soilProperty, setSoilProperty] = useState('none'); // 'none', 'clay', 'bulk', 'wrb'
  const [soilDepth, setSoilDepth] = useState('0_5'); // '0_5', '5_15'

  // Slope units
  const [showSlopeUnits, setShowSlopeUnits] = useState(false);
  const [slopeUnitColor, setSlopeUnitColor] = useState('fos');

  // Danger Zones (FoS filter overlay on slope-units layer)
  const [showDangerZones, setShowDangerZones] = useState(false);
  const [dangerThreshold, setDangerThreshold] = useState(1.5);
  const [maxFos, setMaxFos] = useState(0);
  const [dangerCount, setDangerCount] = useState(0);
  const slopeUnitsFeaturesRef = useRef([]);

  // NASA Satellite Panel
  const [showSatellitePanel, setShowSatellitePanel] = useState(true);
  const [fetchDate, setFetchDate] = useState('2026-04-12');
  const [fetchPeriod, setFetchPeriod] = useState(30);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState({ step: '', percent: 0 });
  const [dataLoaded, setDataLoaded] = useState(false);
  const [activeNasaLayer, setActiveNasaLayer] = useState(null); // null, 'rainfall', 'smap', 'ndvi', 'et'
  const [rainfallMetric, setRainfallMetric] = useState('rain_7d');
  const [dailySeries, setDailySeries] = useState([]);
  const [smapSeries, setSmapSeries] = useState([]);
  const [cacheInfo, setCacheInfo] = useState(null);
  const [showCacheManager, setShowCacheManager] = useState(false);
  const [hoverEnabled, setHoverEnabled] = useState(false);
  const [showBottomPanel, setShowBottomPanel] = useState(false);
  const [bottomTab, setBottomTab] = useState('rainfall');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState('');
  const [analysisComplete, setAnalysisComplete] = useState(false);
  const [nasaFeatures, setNasaFeatures] = useState({ rainfall: [], smap: [], ndvi: [], et: [] });
  const [selectedCache, setSelectedCache] = useState({ rainfall: [], smap: [], ndvi: [], et: [] });
  const [isDeletingCache, setIsDeletingCache] = useState(false);

  // Trạng thái Inspector
  const [inspectedData, setInspectedData] = useState(null);
  const [isInspectorActive, setIsInspectorActive] = useState(false);
  const [isSearchActive, setIsSearchActive] = useState(false);
  const isInspectorActiveRef = useRef(isInspectorActive);

  // Trạng thái Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchError, setSearchError] = useState('');

  // Trạng thái Batch Extraction
  const [isBatchActive, setIsBatchActive] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [extractionResolution, setExtractionResolution] = useState(50); // Mặc định 50m
  const [isAreaLocked, setIsAreaLocked] = useState(false);
  const [hasPolygon, setHasPolygon] = useState(false);
  const drawRef = useRef(null);
  const isCancelledRef = useRef(false);

  // Hàm thực thi trích xuất dữ liệu (dùng chung cho Hover và Search)
  const performExtraction = (lng, lat) => {
    if (!map.current) return;
    
    const data = extractDataForPoint(lng, lat, map.current);
    if (data) {
      data.isPlaceholder = false;
      setInspectedData(data);
    }
  };

  // Đồng bộ hóa biến ref để dùng trong event listener
  useEffect(() => {
    isInspectorActiveRef.current = isInspectorActive;
    if (map.current && map.current.isStyleLoaded()) {
      map.current.getCanvasContainer().style.cursor = isInspectorActive ? 'crosshair' : '';
    }
  }, [isInspectorActive, isSearchActive]);

  const loadCacheInfo = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/cache-status`);
      if (res.ok) setCacheInfo(await res.json());
    } catch (e) {
      console.error('Failed to load cache info', e);
    }
  };

  useEffect(() => {
    if (showSatellitePanel) loadCacheInfo();
  }, [showSatellitePanel]);

  // How many days in the selected fetch range are already in rainfall cache
  const cachedDays = useMemo(() => {
    if (!cacheInfo?.rainfall || !fetchDate) return null;
    const [y, m, d] = fetchDate.split('-').map(Number);
    const cachedSet = new Set(cacheInfo.rainfall.map(f => f.date));
    let count = 0;
    for (let i = 0; i < fetchPeriod; i++) {
      const dt = new Date(y, m - 1, d - i);
      const s = String(dt.getFullYear()) +
        String(dt.getMonth() + 1).padStart(2, '0') +
        String(dt.getDate()).padStart(2, '0');
      if (cachedSet.has(s)) count++;
    }
    return { cached: count, total: fetchPeriod };
  }, [cacheInfo, fetchDate, fetchPeriod]);

  // Precompute cumulative rainfall metrics (reversed, newest first) — only recomputes when dailySeries changes
  const dailyTableRows = useMemo(() => {
    if (dailySeries.length === 0) return [];
    return [...dailySeries].reverse().map((d, idx) => {
      const realIdx = dailySeries.length - 1 - idx;
      const cum3 = dailySeries.slice(Math.max(0, realIdx - 2), realIdx + 1).reduce((s, x) => s + x.mean, 0);
      const cum7 = dailySeries.slice(Math.max(0, realIdx - 6), realIdx + 1).reduce((s, x) => s + x.mean, 0);
      const cum15 = dailySeries.slice(Math.max(0, realIdx - 14), realIdx + 1).reduce((s, x) => s + x.mean, 0);
      const alert = d.max > 50 || cum3 > 50 || cum7 > 100 || cum15 > 200;
      return { ...d, cum3, cum7, cum15, alert };
    });
  }, [dailySeries]);

  // Extract all features from a map source for bottom panel tables
  const getSourceFeatures = (sourceId) => {
    try {
      if (!map.current || !map.current.isStyleLoaded() || !map.current.getSource(sourceId)) return [];
      return map.current.querySourceFeatures(sourceId);
    } catch (_) { return []; }
  };

  useEffect(() => {
    if (map.current) return;
    
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/outdoors-v12',
      center: [104.1, 22.35],
      zoom: 9,
      minZoom: 7.5,
      maxBounds: LAO_CAI_BOUNDS,
      pitch: 0,
      dragPitch: false,
      pitchWithRotate: false,
      antialias: true
    });

    map.current.on('load', () => {
      // Initialize Mapbox GL Draw
      const draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: {
          polygon: true,
          trash: true
        },
        defaultMode: 'simple_select'
      });
      drawRef.current = draw;
      map.current.addControl(draw, 'top-right');

      const updateDrawingStatus = () => {
        if (drawRef.current) {
          const data = drawRef.current.getAll();
          setHasPolygon(data.features.length > 0);
        }
      };

      map.current.on('draw.create', updateDrawingStatus);
      map.current.on('draw.update', updateDrawingStatus);
      map.current.on('draw.delete', updateDrawingStatus);

      // THUẬT TOÁN ĐỘ CAO
      map.current.addSource('mapbox-dem', {
        'type': 'raster-dem',
        'url': 'mapbox://mapbox.mapbox-terrain-dem-v1',
        'tileSize': 512,
        'maxzoom': 14
      });
      map.current.setTerrain({ 'source': 'mapbox-dem', 'exaggeration': 1 });

      // ADD TERRAIN SOURCE FOR CONTOURS
      map.current.addSource('mapbox-terrain-vector', {
        type: 'vector',
        url: 'mapbox://mapbox.mapbox-terrain-v2'
      });
      
      map.current.addLayer({
        'id': 'contours',
        'type': 'line',
        'source': 'mapbox-terrain-vector',
        'source-layer': 'contour',
        'layout': {
          'line-join': 'round',
          'line-cap': 'round'
        },
        'paint': {
          'line-color': '#877b59',
          'line-width': ['match', ['get', 'index'], 5, 1, 10, 2, 0.5],
          'line-opacity': 0.3
        }
      });

      if (map.current.getLayer('admin-0-boundary')) {
        map.current.setPaintProperty('admin-0-boundary', 'line-color', '#000000');
        map.current.setPaintProperty('admin-0-boundary', 'line-width', 4);
      }

      map.current.addSource('lao-cai-source', {
        'type': 'geojson',
        'data': laoCaiBoundary
      });

      map.current.addLayer({
        'id': 'lao-cai-border',
        'type': 'line',
        'source': 'lao-cai-source',
        'paint': {
          'line-color': '#2563eb',
          'line-width': 4,
          'line-opacity': 0.8
        }
      });

      map.current.addLayer({
        'id': 'lao-cai-fill',
        'type': 'fill',
        'source': 'lao-cai-source',
        'paint': {
          'fill-color': '#2563eb',
          'fill-opacity': 0.03
        }
      }, 'lao-cai-border');

      // SOIL DATA LAYER (SoilGrids)
      map.current.addSource('soil-data', {
        type: 'geojson',
        data: '/lao_cai_soil_consolidated.geojson'
      });
      map.current.addLayer({
        id: 'soil-fill',
        type: 'fill',
        source: 'soil-data',
        paint: {
          'fill-color': '#888888',
          'fill-opacity': 0
        }
      }, 'lao-cai-border');
      map.current.addLayer({
        id: 'soil-outline',
        type: 'line',
        source: 'soil-data',
        paint: {
          'line-color': 'rgba(0,0,0,0.13)',
          'line-width': 0.3,
          'line-opacity': 0
        }
      }, 'lao-cai-border');

      // SMAP SOIL MOISTURE LAYER
      map.current.addSource('smap-data', {
        type: 'geojson',
        data: '/lao_cai_smap.geojson'
      });
      map.current.addLayer({
        id: 'smap-fill',
        type: 'fill',
        source: 'smap-data',
        paint: { 'fill-color': '#888', 'fill-opacity': 0 }
      }, 'lao-cai-border');

      // NDVI LAYER
      map.current.addSource('ndvi-data', {
        type: 'geojson',
        data: '/lao_cai_ndvi.geojson'
      });
      map.current.addLayer({
        id: 'ndvi-fill',
        type: 'fill',
        source: 'ndvi-data',
        paint: { 'fill-color': '#888', 'fill-opacity': 0 }
      }, 'lao-cai-border');

      // EVAPOTRANSPIRATION LAYER
      map.current.addSource('et-data', {
        type: 'geojson',
        data: '/lao_cai_et.geojson'
      });
      map.current.addLayer({
        id: 'et-fill',
        type: 'fill',
        source: 'et-data',
        paint: { 'fill-color': '#888', 'fill-opacity': 0 }
      }, 'lao-cai-border');

      // SLOPE UNITS LAYER
      map.current.addSource('slope-units', {
        type: 'geojson',
        data: '/lao_cai_slope_units.geojson'
      });
      map.current.addLayer({
        id: 'slope-units-fill',
        type: 'fill',
        source: 'slope-units',
        paint: {
          'fill-color': '#888',
          'fill-opacity': 0
        }
      }, 'lao-cai-border');
      map.current.addLayer({
        id: 'slope-units-outline',
        type: 'line',
        source: 'slope-units',
        paint: {
          'line-color': '#000000',
          'line-width': 1,
          'line-opacity': 0
        }
      }, 'lao-cai-border');

      // RAINFALL LAYER (NASA GPM IMERG)
      map.current.addSource('rainfall-data', {
        type: 'geojson',
        data: '/lao_cai_rainfall.geojson'
      });
      map.current.addLayer({
        id: 'rainfall-fill',
        type: 'fill',
        source: 'rainfall-data',
        paint: {
          'fill-color': '#888',
          'fill-opacity': 0
        }
      }, 'lao-cai-border');
      map.current.addLayer({
        id: 'rainfall-outline',
        type: 'line',
        source: 'rainfall-data',
        paint: {
          'line-color': 'rgba(0,0,0,0.19)',
          'line-width': 0.5,
          'line-opacity': 0
        }
      }, 'lao-cai-border');

      // ENGINE TRÍCH XUẤT DỮ LIỆU HOVER WITH THROTTLE (100ms limit)
      const throttledExtraction = throttle((e) => {
        if (!isInspectorActiveRef.current) return;
        performExtraction(e.lngLat.lng, e.lngLat.lat);
      }, 100);

      map.current.on('mousemove', throttledExtraction);

    });
  }, []);

  // Xử lý bật tắt Layer
  useEffect(() => {
    if (!map.current || !map.current.isStyleLoaded()) return;

    TARGET_LAYERS.roads.forEach(layerId => {
      if (map.current.getLayer(layerId)) {
        if (showRoads) {
          map.current.setPaintProperty(layerId, 'line-color', '#fbbf24');
          map.current.setPaintProperty(layerId, 'line-width', 3);
        } else {
          map.current.setPaintProperty(layerId, 'line-color', '#ffffff');
          map.current.setPaintProperty(layerId, 'line-width', 1);
        }
      }
    });

    TARGET_LAYERS.water.forEach(layerId => {
      if (map.current.getLayer(layerId)) {
        if (layerId === 'waterway') {
           map.current.setPaintProperty(layerId, 'line-color', '#22d3ee');
           map.current.setPaintProperty(layerId, 'line-width', showWater ? 4 : 1);
        }
      }
    });
  }, [showRoads, showWater]);

  // Soil layer visualization
  useEffect(() => {
    if (!map.current || !map.current.isStyleLoaded()) return;
    if (!map.current.getLayer('soil-fill')) return;

    if (soilProperty === 'none') {
      map.current.setPaintProperty('soil-fill', 'fill-color', 'rgba(0,0,0,0)');
      map.current.setPaintProperty('soil-fill', 'fill-opacity', 1);
      map.current.setPaintProperty('soil-outline', 'line-opacity', 0);
      return;
    }

    map.current.setPaintProperty('soil-outline', 'line-opacity', 0.3);

    const WRB_COLORS = {
      0: '#cccccc', 2: '#e6194b', 3: '#3cb44b', 6: '#ffe119',
      10: '#4363d8', 16: '#f58231', 18: '#911eb4', 20: '#42d4f4',
      24: '#f032e6', 29: '#bfef45'
    };

    if (soilProperty === 'clay') {
      const prop = soilDepth === '0_5' ? 'clay_0_5' : 'clay_5_15';
      map.current.setPaintProperty('soil-fill', 'fill-color', [
        'interpolate', ['linear'], ['get', prop],
        18, '#ffffd4',
        24, '#fed98e',
        28, '#fe9929',
        32, '#d95f0e',
        36, '#993404',
        41, '#662506'
      ]);
      map.current.setPaintProperty('soil-fill', 'fill-opacity', 0.55);
    } else if (soilProperty === 'bulk') {
      const prop = soilDepth === '0_5' ? 'bulk_0_5' : 'bulk_5_15';
      map.current.setPaintProperty('soil-fill', 'fill-color', [
        'interpolate', ['linear'], ['get', prop],
        0.85, '#f1eef6',
        0.95, '#bdc9e1',
        1.05, '#74a9cf',
        1.15, '#2b8cbe',
        1.25, '#045a8d',
        1.35, '#023858'
      ]);
      map.current.setPaintProperty('soil-fill', 'fill-opacity', 0.55);
    } else if (soilProperty === 'wrb') {
      const colorStops = Object.entries(WRB_COLORS).flatMap(([id, color]) => [Number(id), color]);
      map.current.setPaintProperty('soil-fill', 'fill-color', [
        'match', ['get', 'wrb_id'],
        ...colorStops,
        '#cccccc'
      ]);
      map.current.setPaintProperty('soil-fill', 'fill-opacity', 0.55);
    }
  }, [soilProperty, soilDepth]);

  // NASA layer visualization - single active layer
  useEffect(() => {
    if (!map.current || !map.current.isStyleLoaded()) return;

    const layers = ['rainfall-fill', 'smap-fill', 'ndvi-fill', 'et-fill'];
    const outlines = ['rainfall-outline'];

    // Hide all first by making them transparent but queryable
    layers.forEach(l => { 
      if (map.current.getLayer(l)) {
        map.current.setPaintProperty(l, 'fill-color', 'rgba(0,0,0,0)');
        map.current.setPaintProperty(l, 'fill-opacity', 1);
      }
    });
    outlines.forEach(l => { if (map.current.getLayer(l)) map.current.setPaintProperty(l, 'line-opacity', 0); });

    if (!activeNasaLayer) return;

    if (activeNasaLayer === 'rainfall' && map.current.getLayer('rainfall-fill')) {
      const cumulativeMaps = {
        rain_today: ['interpolate', ['linear'], ['get', 'rain_today'], 0, '#f7fbff', 5, '#c6dbef', 15, '#6baed6', 30, '#2171b5', 60, '#08306b'],
        rain_3d: ['interpolate', ['linear'], ['get', 'rain_3d'], 0, '#f7fbff', 10, '#c6dbef', 30, '#6baed6', 60, '#2171b5', 120, '#08306b'],
        rain_7d: ['interpolate', ['linear'], ['get', 'rain_7d'], 0, '#ffffcc', 20, '#a1dab4', 50, '#41b6c4', 100, '#2c7fb8', 200, '#253494'],
        rain_15d: ['interpolate', ['linear'], ['get', 'rain_15d'], 0, '#ffffcc', 40, '#a1dab4', 100, '#41b6c4', 200, '#2c7fb8', 400, '#253494'],
        rain_30d: ['interpolate', ['linear'], ['get', 'rain_30d'], 0, '#ffffcc', 80, '#a1dab4', 160, '#41b6c4', 300, '#2c7fb8', 500, '#253494'],
        rain_max: ['interpolate', ['linear'], ['get', 'rain_max'], 0, '#f7fbff', 10, '#c6dbef', 30, '#6baed6', 60, '#2171b5', 120, '#08306b']
      };
      const dailyColorMap = ['interpolate', ['linear'], ['get', rainfallMetric], 0, '#f7fbff', 5, '#c6dbef', 15, '#6baed6', 30, '#2171b5', 60, '#08306b'];
      const colorExpr = cumulativeMaps[rainfallMetric] || (rainfallMetric.startsWith('d_') ? dailyColorMap : cumulativeMaps.rain_7d);
      map.current.setPaintProperty('rainfall-fill', 'fill-color', colorExpr);
      map.current.setPaintProperty('rainfall-fill', 'fill-opacity', 0.6);
      map.current.setPaintProperty('rainfall-fill', 'fill-antialias', false);
      map.current.setPaintProperty('rainfall-outline', 'line-opacity', 0.3);
    }

    if (activeNasaLayer === 'smap' && map.current.getLayer('smap-fill')) {
      map.current.setPaintProperty('smap-fill', 'fill-color', [
        'interpolate', ['linear'], ['get', 'sm_mean'],
        0.05, '#fff7ec', 0.10, '#fee8c8', 0.15, '#fdd49e', 0.20, '#fdbb84', 0.25, '#fc8d59', 0.30, '#e34a33', 0.40, '#b30000'
      ]);
      map.current.setPaintProperty('smap-fill', 'fill-opacity', 0.6);
      map.current.setPaintProperty('smap-fill', 'fill-antialias', false);
    }

    if (activeNasaLayer === 'ndvi' && map.current.getLayer('ndvi-fill')) {
      map.current.setPaintProperty('ndvi-fill', 'fill-color', [
        'interpolate', ['linear'], ['get', 'ndvi'],
        0.0, '#d73027', 0.2, '#fc8d59', 0.4, '#fee08b', 0.6, '#d9ef8b', 0.8, '#1a9850', 1.0, '#006837'
      ]);
      map.current.setPaintProperty('ndvi-fill', 'fill-opacity', 0.6);
      map.current.setPaintProperty('ndvi-fill', 'fill-antialias', false);
    }

    if (activeNasaLayer === 'et' && map.current.getLayer('et-fill')) {
      map.current.setPaintProperty('et-fill', 'fill-color', [
        'interpolate', ['linear'], ['get', 'et'],
        0, '#f7fcf0', 10, '#c7e9b4', 20, '#7fcdbb', 30, '#41b6c4', 40, '#1d91c0', 50, '#0c2c84'
      ]);
      map.current.setPaintProperty('et-fill', 'fill-opacity', 0.6);
      map.current.setPaintProperty('et-fill', 'fill-antialias', false);
    }
  }, [activeNasaLayer, rainfallMetric]);

  // Hover tooltip — shows NASA data at cursor position
  useEffect(() => {
    if (!map.current) return;
    if (!hoverEnabled || !dataLoaded) return;

    const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });
    const nasaLayers = ['rainfall-fill', 'smap-fill', 'ndvi-fill', 'et-fill'];

    const onMove = (e) => {
      const available = nasaLayers.filter(l => map.current.getLayer(l));
      if (!available.length) return;

      const features = map.current.queryRenderedFeatures(e.point, { layers: available });
      if (!features.length) { popup.remove(); return; }

      const parts = [];
      const seen = new Set();
      for (const f of features) {
        if (seen.has(f.layer.id)) continue;
        seen.add(f.layer.id);
        const p = f.properties;

        if (f.layer.id === 'rainfall-fill' && p.rain_today !== undefined) {
          const key = rainfallMetric || 'rain_7d';
          const labels = { rain_today: 'Today', rain_3d: '3d', rain_7d: '7d', rain_15d: '15d', rain_30d: '30d', rain_max: 'Max' };
          const label = key.startsWith('d_') ? key.slice(6,8) + '/' + key.slice(8) : labels[key];
          const val = p[key];
          if (val !== undefined) parts.push(`<b>Rain ${label}</b> ${val} mm`);
        }
        if (f.layer.id === 'smap-fill' && p.sm_mean !== undefined)
          parts.push(`<b>Soil</b> ${p.sm_mean} m\u00B3/m\u00B3`);
        if (f.layer.id === 'ndvi-fill' && p.ndvi !== undefined)
          parts.push(`<b>NDVI</b> ${p.ndvi}`);
        if (f.layer.id === 'et-fill' && p.et !== undefined)
          parts.push(`<b>ET</b> ${p.et} mm/8d`);
      }

      if (!parts.length) { popup.remove(); return; }
      popup.setLngLat(e.lngLat)
        .setHTML(parts.join('<br>'))
        .addTo(map.current);
    };

    map.current.on('mousemove', onMove);
    return () => {
      popup.remove();
      if (map.current) { try { map.current.off('mousemove', onMove); } catch(_){} }
    };
  }, [rainfallMetric, hoverEnabled, dataLoaded]);

  // Slope units visualization
  useEffect(() => {
    if (!map.current || !map.current.isStyleLoaded()) return;
    if (!map.current.getLayer('slope-units-fill')) return;

    if (!showSlopeUnits) {
      map.current.setPaintProperty('slope-units-fill', 'fill-color', 'rgba(0,0,0,0)');
      map.current.setPaintProperty('slope-units-fill', 'fill-opacity', 1);
      map.current.setPaintProperty('slope-units-outline', 'line-opacity', 0);
      return;
    }

    map.current.setPaintProperty('slope-units-outline', 'line-opacity', 0.6);
    map.current.setPaintProperty('slope-units-outline', 'line-width', 1.2);

    const colorMaps = {
      mean_slope: [
        'interpolate', ['linear'], ['get', 'mean_slope'],
        5, '#2b83ba',
        15, '#abdda4',
        25, '#ffffbf',
        35, '#fdae61',
        50, '#d7191c'
      ],
      elev_range: [
        'interpolate', ['linear'], ['get', 'elev_range'],
        0, '#f7fcf5',
        100, '#c7e9c0',
        300, '#74c476',
        600, '#238b45',
        1000, '#00441b'
      ],
      mean_elev: [
        'interpolate', ['linear'], ['get', 'mean_elev'],
        100, '#f7fbff',
        500, '#c6dbef',
        1000, '#6baed6',
        1500, '#2171b5',
        2500, '#08306b'
      ],
      area_km2: [
        'interpolate', ['linear'], ['get', 'area_km2'],
        0, '#fff5eb',
        2, '#fdbe85',
        5, '#fd8d3c',
        10, '#e6550d',
        20, '#a63603'
      ],
      fos: [
        'interpolate', ['linear'], ['get', 'fos'],
        0.5, '#d7191c',
        0.8, '#e85285',
        1.0, '#fdae61',
        1.2, '#ffffbf',
        1.5, '#abdda4',
        3.0, '#2b83ba'
      ]
    };

    map.current.setPaintProperty('slope-units-fill', 'fill-color', colorMaps[slopeUnitColor] || colorMaps.mean_slope);
    map.current.setPaintProperty('slope-units-fill', 'fill-opacity', 0.5);
  }, [showSlopeUnits, slopeUnitColor]);

  // Danger Zones: fetch slope-units geojson once, cache features + compute max FoS
  useEffect(() => {
    let cancelled = false;
    fetch('/lao_cai_slope_units.geojson')
      .then(r => r.json())
      .then(geojson => {
        if (cancelled) return;
        const feats = geojson?.features || [];
        slopeUnitsFeaturesRef.current = feats;
        const fosValues = feats
          .map(f => f?.properties?.fos)
          .filter(v => typeof v === 'number' && Number.isFinite(v));
        if (fosValues.length > 0) {
          setMaxFos(Math.max(...fosValues));
        }
      })
      .catch(err => {
        console.error('Danger Zones: failed to load slope-units geojson', err);
      });
    return () => { cancelled = true; };
  }, []);

  // Xử lý Tìm kiếm tọa độ
  // --- BATCH EXTRACTION ENGINE (VIEWPORT-CRAWLING) ---
  const executeBatchProcess = (polygonFeature, resolutionMeters, fileNamePrefix) => {
    if (!map.current) return;

    setIsBatchActive(true);
    setBatchProgress(0);
    isCancelledRef.current = false;

    const resolutionKm = resolutionMeters / 1000;
    const EXTRACTION_ZOOM = 14.5; // Zoom cố định để đảm bảo terrain DEM luôn available

    try {
      const bbox = turf.bbox(polygonFeature);
      const grid = turf.pointGrid(bbox, resolutionKm, { units: 'kilometers', mask: polygonFeature });

      const totalPoints = grid.features.length;
      if (totalPoints === 0) {
        alert("Vùng quét quá nhỏ hoặc không hợp lệ với độ phân giải này.");
        setIsBatchActive(false);
        return;
      }

      if (totalPoints > 50000) {
        const userConfirm = window.confirm(`Cảnh báo: Có tới ${totalPoints.toLocaleString()} điểm cần quét. Quá trình này sẽ mất rất nhiều thời gian. Bạn có chắc chắn muốn tiếp tục không?`);
        if (!userConfirm) {
          setIsBatchActive(false);
          return;
        }
      }

      // --- BƯỚC 1: Chia grid thành các spatial tiles (clusters) ---
      // Tính kích thước viewport ở zoom 14.5 (khoảng ~0.02 degree mỗi chiều)
      const tileSizeDeg = 0.018; // ~2km mỗi tile, vừa khớp viewport ở zoom 14.5
      const tiles = {};

      grid.features.forEach((feature, idx) => {
        const [lng, lat] = feature.geometry.coordinates;
        const tileKey = `${Math.floor(lng / tileSizeDeg)}_${Math.floor(lat / tileSizeDeg)}`;
        if (!tiles[tileKey]) {
          tiles[tileKey] = {
            points: [],
            centerLng: 0,
            centerLat: 0
          };
        }
        tiles[tileKey].points.push({ lng, lat, idx });
        tiles[tileKey].centerLng += lng;
        tiles[tileKey].centerLat += lat;
      });

      // Tính trung tâm của mỗi tile
      const tileList = Object.values(tiles).map(tile => {
        tile.centerLng /= tile.points.length;
        tile.centerLat /= tile.points.length;
        return tile;
      });

      let results = [];
      let processedPoints = 0;
      let currentTileIndex = 0;

      // --- BƯỚC 2: Xử lý từng tile theo kiểu viewport-crawling ---
      const processNextTile = () => {
        if (isCancelledRef.current) {
          setIsBatchActive(false);
          setBatchProgress(0);
          return;
        }

        if (currentTileIndex >= tileList.length) {
          // Hoàn tất - export CSV
          setIsBatchActive(false);
          exportToCSV(results, fileNamePrefix);
          return;
        }

        const tile = tileList[currentTileIndex];

        // Di chuyển camera đến trung tâm tile (KHÔNG animation để nhanh hơn)
        map.current.jumpTo({
          center: [tile.centerLng, tile.centerLat],
          zoom: EXTRACTION_ZOOM
        });

        // Chờ map idle (terrain DEM tiles đã nạp xong) rồi mới extract
        const onIdle = () => {
          // Thêm delay nhỏ đảm bảo terrain hoàn toàn sẵn sàng
          setTimeout(() => {
            if (isCancelledRef.current) {
              setIsBatchActive(false);
              setBatchProgress(0);
              return;
            }

            // Query road/water features cho tile này
            const allFeatures = map.current.queryRenderedFeatures();
            const roadsOnScreen = allFeatures.filter(f => f.layer && TARGET_LAYERS.roads.includes(f.layer.id));
            const waterOnScreen = allFeatures.filter(f => {
              const sl = f.sourceLayer || (f.layer && f.layer['source-layer']);
              return sl && TARGET_LAYERS.water.includes(sl);
            });

            // Extract data cho tất cả points trong tile này
            tile.points.forEach(p => {
              if (isCancelledRef.current) return;

              const extractedData = extractDataForPoint(p.lng, p.lat, map.current, { roads: roadsOnScreen, water: waterOnScreen });

              results.push({
                lng: p.lng.toFixed(6),
                lat: p.lat.toFixed(6),
                elevation: extractedData.elevation,
                slope: extractedData.slope,
                aspect: extractedData.aspect,
                tri: extractedData.tri,
                tpi: extractedData.tpi,
                curvature: extractedData.curvature,
                riskLevel: extractedData.riskLevel,
                lsi: extractedData.lsi,
                landCover: extractedData.landCover,
                armorLabel: extractedData.armorLabel,
                distRoad: extractedData.distRoad,
                distWater: extractedData.distWater
              });

              processedPoints++;
            });

            setBatchProgress(Math.round((processedPoints / totalPoints) * 100));

            // Chuyển sang tile tiếp theo
            currentTileIndex++;
            requestAnimationFrame(processNextTile);
          }, 600); // 600ms delay cho terrain DEM load hoàn toàn
        };

        map.current.once('idle', onIdle);
      };

      // Bắt đầu crawl từ tile đầu tiên
      processNextTile();
    } catch (err) {
      console.error("Batch Error:", err);
      alert("Lỗi trong quá trình tạo lưới điểm.");
      setIsBatchActive(false);
    }
  };

  const startBatchExtraction = () => {
    if (!drawRef.current) return;
    const data = drawRef.current.getAll();
    if (data.features.length === 0) {
      alert("Hãy vẽ một vùng (Polygon) trên bản đồ trước.");
      return;
    }
    const res = parseInt(extractionResolution) || 50;
    executeBatchProcess(data.features[0], res, 'custom_region');
  };

  const startProvinceExtraction = () => {
    const res = parseInt(extractionResolution) || 50;
    executeBatchProcess(laoCaiBoundary, res, 'lao_cai_province_full');
  };

  const handleLockArea = () => {
    if (drawRef.current) {
      drawRef.current.changeMode('simple_select');
      // Bỏ chọn tất cả các feature để không hiện các nốt chấm (vertices) gây méo hình
      drawRef.current.set({ type: 'FeatureCollection', features: drawRef.current.getAll().features });
      setIsAreaLocked(true);
    }
  };

  const handleRedraw = () => {
    if (drawRef.current) {
      drawRef.current.deleteAll();
      setHasPolygon(false);
      setIsAreaLocked(false);
    }
  };

  // Lắng nghe sự kiện phím Enter để khóa vùng vẽ
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Enter' && hasPolygon && !isAreaLocked && !isBatchActive) {
        e.preventDefault();
        handleLockArea();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasPolygon, isAreaLocked, isBatchActive]);

  const exportToCSV = (data, prefix) => {
    if (data.length === 0) return;
    const headers = Object.keys(data[0]);
    const csvRows = [
      headers.join(','),
      ...data.map(row => headers.map(fieldName => `"${row[fieldName]}"`).join(','))
    ];
    
    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${prefix}_${new Date().getTime()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setSearchError('');

    // Tách chuỗi theo dấu phẩy
    const parts = searchQuery.split(',').map(p => p.trim());
    
    if (parts.length !== 2) {
      setSearchError('Format: Latitude, Longitude (e.g. 22.35, 103.77)');
      return;
    }

    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);

    if (isNaN(lat) || isNaN(lng)) {
      setSearchError('Invalid numbers. Use format: Lat, Lng');
      return;
    }

    if (lat < LAO_CAI_BOUNDS[0][1] || lat > LAO_CAI_BOUNDS[1][1] || lng < LAO_CAI_BOUNDS[0][0] || lng > LAO_CAI_BOUNDS[1][0]) {
      setSearchError('Coordinates out of Lao Cai bounds.');
      return;
    }

    setIsInspectorActive(false);
    setIsSearchActive(true);

    if (searchMarker.current) {
      searchMarker.current.remove();
    }

    searchMarker.current = new mapboxgl.Marker({ color: '#ef4444' })
      .setLngLat([lng, lat])
      .addTo(map.current);

    map.current.flyTo({
      center: [lng, lat],
      zoom: 15.5,
      essential: true
    });

    // Chờ bản đồ "Idle" và nạp xong Tile cao độ cao nhất
    map.current.once('idle', () => {
      setTimeout(() => {
        if (!map.current) return;
        const point = map.current.project([lng, lat]);
        performExtraction(lng, lat);
      }, 500);
    });
  };

  const toggleInspector = () => {
    const nextState = !isInspectorActive;
    if (nextState) {
      // Khi bật Inspector
      setIsSearchActive(false);
      if (searchMarker.current) {
        searchMarker.current.remove();
        searchMarker.current = null;
      }
      // Khởi tạo data rỗng để hiện bảng ngay lập tức
      setInspectedData({
        lngLat: ['--', '--'],
        elevation: '--',
        slope: '--',
        aspect: '--',
        tri: '--',
        curvature: '--',
        riskLevel: 'Waiting...',
        riskColor: 'text-slate-400',
        lsi: '--',
        lsiColor: 'text-slate-400',
        landCover: '--',
        distRoad: '--',
        distWater: '--',
        zoomWarning: false,
        isPlaceholder: true,
        missingInputs: ['Soil', 'NDVI', 'Rainfall', 'SMAP', 'ET']
      });
    } else {
      // Khi tắt Inspector
      setInspectedData(null);
    }
    setIsInspectorActive(nextState);
  };

  return (
    <div className="fixed inset-0 w-screen h-screen font-sans overflow-hidden bg-slate-100">
      
      {/* Sidebar Control Panel */}
      <div className="absolute top-0 left-0 h-full w-80 bg-white/95 backdrop-blur-xl border-r border-slate-200 z-10 flex flex-col shadow-2xl">
        <div className="p-8 border-b border-slate-100">
          <h1 className="text-xl font-bold text-slate-900 uppercase tracking-wide leading-tight">
            Landslide Analysis <br/>
            <span className="font-black text-2xl tracking-tighter">Lào Cai Province</span>
          </h1>
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.2em] mt-3">
            2D Map Mode Locked
          </p>
        </div>

        <div className="p-8 flex-1 overflow-y-auto">
          {/* SEARCH ENGINE SECTION */}
          <div className="mb-10 pb-10 border-b border-slate-100">
            <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Search Engine</h2>
            <form onSubmit={handleSearch}>
              <div className="mb-3">
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Coordinates (Lat, Lng)</label>
                <input 
                  type="text" 
                  placeholder="e.g. 22.3364, 103.8438" 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-700 outline-none focus:border-blue-500 transition-colors shadow-inner"
                />
              </div>
              {searchError && <p className="text-[10px] text-rose-500 font-bold mt-2">{searchError}</p>}
              <button 
                type="submit"
                className="w-full mt-2 py-3 bg-blue-600 text-white rounded-lg text-xs font-bold uppercase tracking-widest hover:bg-blue-700 transition-colors shadow-md shadow-blue-600/20"
              >
                Extract Coordinates
              </button>
            </form>
          </div>

          <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-6">X-Ray Visualizers</h2>
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold text-slate-800 uppercase tracking-wider">Infrastructure</p>
                <p className="text-[10px] text-slate-500 font-medium mt-1">Road networks & Paths</p>
              </div>
              <button 
                onClick={() => setShowRoads(!showRoads)}
                className={`w-12 h-6 rounded-full transition-colors duration-300 relative ${showRoads ? 'bg-amber-500' : 'bg-slate-200'}`}
              >
                <div className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-transform duration-300 shadow-sm ${showRoads ? 'translate-x-7' : 'translate-x-1'}`} />
              </button>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold text-slate-800 uppercase tracking-wider">Hydrology</p>
                <p className="text-[10px] text-slate-500 font-medium mt-1">Rivers & Waterways</p>
              </div>
              <button 
                onClick={() => setShowWater(!showWater)}
                className={`w-12 h-6 rounded-full transition-colors duration-300 relative ${showWater ? 'bg-cyan-500' : 'bg-slate-200'}`}
              >
                <div className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-transform duration-300 shadow-sm ${showWater ? 'translate-x-7' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>

          {/* SLOPE UNITS PANEL */}
          <div className="mt-8 pt-8 border-t border-slate-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Slope Units</h2>
              <button
                onClick={() => setShowSlopeUnits(!showSlopeUnits)}
                className={`w-12 h-6 rounded-full transition-colors duration-300 relative ${showSlopeUnits ? 'bg-rose-500' : 'bg-slate-200'}`}
              >
                <div className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-transform duration-300 shadow-sm ${showSlopeUnits ? 'translate-x-7' : 'translate-x-1'}`} />
              </button>
            </div>
            {showSlopeUnits && (
              <>
                <p className="text-[10px] text-slate-400 mb-2">Color by:</p>
                <div className="space-y-1.5">
                  {[
                    { value: 'fos', label: 'Factor of Safety' },
                    { value: 'mean_slope', label: 'Mean Slope (°)' },
                    { value: 'elev_range', label: 'Elevation Range (m)' },
                    { value: 'mean_elev', label: 'Mean Elevation (m)' },
                    { value: 'area_km2', label: 'Area (km²)' }
                  ].map(opt => (
                    <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="slopeUnitColor"
                        value={opt.value}
                        checked={slopeUnitColor === opt.value}
                        onChange={(e) => setSlopeUnitColor(e.target.value)}
                        className="accent-rose-500"
                      />
                      <span className={`text-xs font-medium ${slopeUnitColor === opt.value ? 'text-slate-900 font-bold' : 'text-slate-500'}`}>
                        {opt.label}
                      </span>
                    </label>
                  ))}
                </div>
                {slopeUnitColor === 'fos' && (
                  <div className="mt-2">
                    <div className="h-3 rounded-sm" style={{background: 'linear-gradient(to right, #d7191c, #e85285, #fdae61, #ffffbf, #abdda4, #2b83ba)'}} />
                    <div className="flex justify-between text-[9px] text-slate-400 font-mono mt-0.5">
                      <span>0.5</span><span>1.0</span><span>1.5</span><span>3.0+</span>
                    </div>
                    <div className="flex justify-between text-[8px] mt-0.5">
                      <span className="text-red-500 font-bold">Critical</span><span className="text-yellow-500">Marginal</span><span className="text-emerald-500">Stable</span>
                    </div>
                  </div>
                )}
                {slopeUnitColor === 'mean_slope' && (
                  <div className="mt-2">
                    <div className="h-3 rounded-sm" style={{background: 'linear-gradient(to right, #2b83ba, #abdda4, #ffffbf, #fdae61, #d7191c)'}} />
                    <div className="flex justify-between text-[9px] text-slate-400 font-mono mt-0.5">
                      <span>5°</span><span>25°</span><span>50°</span>
                    </div>
                  </div>
                )}
                {slopeUnitColor === 'elev_range' && (
                  <div className="mt-2">
                    <div className="h-3 rounded-sm" style={{background: 'linear-gradient(to right, #f7fcf5, #c7e9c0, #74c476, #238b45, #00441b)'}} />
                    <div className="flex justify-between text-[9px] text-slate-400 font-mono mt-0.5">
                      <span>0m</span><span>500m</span><span>1000m</span>
                    </div>
                  </div>
                )}
                {slopeUnitColor === 'mean_elev' && (
                  <div className="mt-2">
                    <div className="h-3 rounded-sm" style={{background: 'linear-gradient(to right, #f7fbff, #c6dbef, #6baed6, #2171b5, #08306b)'}} />
                    <div className="flex justify-between text-[9px] text-slate-400 font-mono mt-0.5">
                      <span>100m</span><span>1500m</span><span>2500m</span>
                    </div>
                  </div>
                )}
                {slopeUnitColor === 'area_km2' && (
                  <div className="mt-2">
                    <div className="h-3 rounded-sm" style={{background: 'linear-gradient(to right, #fff5eb, #fdbe85, #fd8d3c, #e6550d, #a63603)'}} />
                    <div className="flex justify-between text-[9px] text-slate-400 font-mono mt-0.5">
                      <span>0</span><span>10</span><span>20 km²</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* SOILGRIDS LAYER PANEL */}
          <div className="mt-8 pt-8 border-t border-slate-100">
            <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">SoilGrids Layer</h2>
            <div className="space-y-2">
              {[
                { value: 'none', label: 'None' },
                { value: 'clay', label: 'Clay Content (%)' },
                { value: 'bulk', label: 'Bulk Density (g/cm³)' },
                { value: 'wrb', label: 'WRB Soil Group' }
              ].map(opt => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="radio"
                    name="soilProperty"
                    value={opt.value}
                    checked={soilProperty === opt.value}
                    onChange={(e) => setSoilProperty(e.target.value)}
                    className="accent-amber-600"
                  />
                  <span className={`text-xs font-medium ${soilProperty === opt.value ? 'text-slate-900 font-bold' : 'text-slate-500'}`}>
                    {opt.label}
                  </span>
                </label>
              ))}
            </div>

            {(soilProperty === 'clay' || soilProperty === 'bulk') && (
              <div className="mt-3 ml-5">
                <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">Depth</p>
                <div className="flex gap-3">
                  {[
                    { value: '0_5', label: '0–5 cm' },
                    { value: '5_15', label: '5–15 cm' }
                  ].map(d => (
                    <label key={d.value} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="soilDepth"
                        value={d.value}
                        checked={soilDepth === d.value}
                        onChange={(e) => setSoilDepth(e.target.value)}
                        className="accent-amber-600"
                      />
                      <span className={`text-[11px] font-medium ${soilDepth === d.value ? 'text-slate-800 font-bold' : 'text-slate-400'}`}>
                        {d.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Legend */}
            {soilProperty === 'clay' && (
              <div className="mt-3 ml-5">
                <div className="h-3 rounded-sm" style={{background: 'linear-gradient(to right, #ffffd4, #fed98e, #fe9929, #d95f0e, #993404, #662506)'}} />
                <div className="flex justify-between text-[9px] text-slate-400 font-mono mt-0.5">
                  <span>18%</span><span>28%</span><span>41%</span>
                </div>
              </div>
            )}
            {soilProperty === 'bulk' && (
              <div className="mt-3 ml-5">
                <div className="h-3 rounded-sm" style={{background: 'linear-gradient(to right, #f1eef6, #bdc9e1, #74a9cf, #2b8cbe, #045a8d, #023858)'}} />
                <div className="flex justify-between text-[9px] text-slate-400 font-mono mt-0.5">
                  <span>0.85</span><span>1.10</span><span>1.35</span>
                </div>
              </div>
            )}
            {soilProperty === 'wrb' && (
              <div className="mt-3 ml-5 grid grid-cols-2 gap-x-3 gap-y-0.5">
                {[
                  [0,'Unknown','#cccccc'], [2,'Cambisol','#e6194b'], [3,'Arenosol','#3cb44b'],
                  [6,'Gleysol','#ffe119'], [10,'Leptosol','#4363d8'], [16,'Acrisol','#f58231'],
                  [18,'Ferralsol','#911eb4'], [20,'Alisol','#42d4f4'], [24,'Umbrisol','#f032e6'],
                  [29,'Fluvisol','#bfef45']
                ].map(([id, name, color]) => (
                  <div key={id} className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{backgroundColor: color}} />
                    <span className="text-[9px] text-slate-500 truncate">{name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-12">
            <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-6">Batch Extraction (Polygon)</h2>
            
            <div className="mb-6">
              <label className="block text-[10px] font-bold text-slate-500 uppercase mb-2">Sampling Resolution (meters)</label>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min="10"
                  max="5000"
                  value={extractionResolution}
                  onChange={(e) => setExtractionResolution(e.target.value)}
                  className="w-24 p-2 bg-slate-50 border border-slate-200 rounded text-xs font-mono text-slate-700 outline-none focus:border-emerald-500 transition-colors shadow-inner"
                />
                <span className="text-[10px] text-slate-400 font-medium italic">Lower = More Detail / Slower</span>
              </div>
            </div>

            <p className="text-[10px] text-slate-500 mb-4 leading-relaxed font-medium">
              Draw a polygon using the tools on the top right.
            </p>

            {hasPolygon && !isAreaLocked && (
              <div className="space-y-3 mb-6">
                <button 
                  onClick={handleLockArea}
                  className="w-full py-3 bg-blue-600 text-white rounded-lg text-xs font-bold uppercase tracking-widest hover:bg-blue-700 transition-colors shadow-lg shadow-blue-600/20 flex items-center justify-center gap-2"
                >
                  <span>✅ Confirm & Lock Area</span>
                  <span className="text-[10px] opacity-60 font-normal">(or press Enter)</span>
                </button>
                <button 
                  onClick={handleRedraw}
                  className="w-full py-2 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-bold uppercase tracking-widest hover:bg-slate-200 transition-colors"
                >
                  Reset / Redraw
                </button>
              </div>
            )}

            {isAreaLocked && (
              <div className="space-y-3 mb-6">
                <div className="p-3 bg-emerald-50 border border-emerald-100 rounded-lg flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-[10px] text-emerald-700 font-bold uppercase">Area Locked & Ready</span>
                </div>
                <button 
                  onClick={handleRedraw}
                  disabled={isBatchActive}
                  className="w-full py-2 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-bold uppercase tracking-widest hover:bg-slate-200 transition-colors disabled:opacity-50"
                >
                  Unlock & Redraw
                </button>
              </div>
            )}

            <div className={`space-y-3 ${(!isAreaLocked && !isBatchActive) ? 'opacity-40 grayscale pointer-events-none' : ''}`}>
              <button 
                onClick={startBatchExtraction}
                disabled={isBatchActive || !isAreaLocked}
                className={`w-full py-3 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${
                  isBatchActive 
                    ? 'bg-slate-300 text-slate-500 cursor-not-allowed' 
                    : 'bg-emerald-600 text-white shadow-lg hover:bg-emerald-700 shadow-emerald-600/20'
                }`}
              >
                {isBatchActive ? `Extracting... ${batchProgress}%` : `Extract Drawn Region (${extractionResolution}m)`}
              </button>

              <button 
                onClick={startProvinceExtraction}
                disabled={isBatchActive}
                className={`w-full py-3 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${
                  isBatchActive 
                    ? 'bg-slate-300 text-slate-500 cursor-not-allowed' 
                    : 'bg-indigo-600 text-white shadow-lg hover:bg-indigo-700 shadow-indigo-600/20'
                }`}
              >
                {isBatchActive ? 'System Busy...' : `Extract Lào Cai Province (${extractionResolution}m)`}
              </button>
            </div>

            {isBatchActive && (
              <div className="mt-4 space-y-3">
                {/* Progress bar */}
                <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-emerald-500 h-2 rounded-full transition-all duration-300 ease-out" 
                    style={{ width: `${batchProgress}%` }}
                  ></div>
                </div>
                <p className="text-[10px] text-slate-500 font-mono text-center">
                  Progress: <span className="font-bold text-emerald-600">{batchProgress}%</span>
                </p>

                {/* Cancel Button */}
                <button
                  onClick={() => {
                    isCancelledRef.current = true;
                  }}
                  className="w-full py-3 rounded-lg text-xs font-bold uppercase tracking-widest transition-all bg-rose-600 text-white shadow-lg hover:bg-rose-700 shadow-rose-600/20 flex items-center justify-center gap-2 animate-pulse hover:animate-none"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                  Cancel Extraction
                </button>
              </div>
            )}
          </div>

          <div className="mt-12">
            <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-6">Hover Inspector</h2>
            <button 
              onClick={toggleInspector}
              className={`w-full py-3 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${
                isInspectorActive 
                  ? 'bg-slate-900 text-white shadow-lg border border-slate-900' 
                  : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
              }`}
            >
              {isInspectorActive ? 'Inspector Active' : 'Enable Hover Inspector'}
            </button>
            <p className="text-[10px] text-slate-500 mt-4 leading-relaxed font-medium">
              Activate to freely extract data by hovering over the map. Disables pinned search results.
            </p>

            <button
              onClick={() => {
                if (map.current) {
                  const currentCenter = map.current.getCenter();
                  map.current.flyTo({ center: currentCenter, zoom: 14.5, essential: true });
                }
              }}
              className="mt-6 w-full py-2 bg-amber-100 hover:bg-amber-200 border border-amber-300 text-amber-800 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-colors shadow-sm flex items-center justify-center gap-2"
            >
              🔍 Auto Zoom (Lv 14.5)
            </button>
          </div>
        </div>
      </div>

      {/* Map Container */}
      <div className="absolute top-0 right-0 h-full" style={{ width: 'calc(100vw - 20rem)' }}>
        <div ref={mapContainer} className="w-full h-full" />
        
        {/* Crosshair when active */}
        {isInspectorActive && (
          <div className="absolute top-1/2 left-1/2 w-4 h-4 -mt-2 -ml-2 pointer-events-none z-10 flex items-center justify-center opacity-50 mix-blend-difference">
             <div className="absolute w-full h-[1px] bg-black"></div>
             <div className="absolute h-full w-[1px] bg-black"></div>
          </div>
        )}
      </div>

      {/* Floating Data Inspector Card */}
      {(isInspectorActive || isSearchActive) && inspectedData && (
        <div className="absolute top-8 right-8 z-20 bg-white/95 backdrop-blur-md border border-slate-200 p-6 rounded-2xl shadow-2xl w-96 pointer-events-none">
          <div className="flex items-center gap-3 mb-4 border-b border-slate-100 pb-4">
            {isSearchActive ? (
               <div className="w-2 h-2 rounded-full bg-rose-500" />
            ) : (
               <div className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
            )}
            <h3 className="text-[11px] font-black text-slate-800 uppercase tracking-widest">
              {isSearchActive ? 'Search Result Vector' : (inspectedData.isPlaceholder ? 'Inspector Ready' : 'Extracted Vector')}
            </h3>
          </div>

          {inspectedData.isPlaceholder && (
            <div className="mb-4 p-2 bg-blue-50 border border-blue-100 rounded-lg animate-pulse">
              <p className="text-[9px] text-blue-700 font-bold leading-tight uppercase">
                🖱️ Move mouse to inspect
              </p>
            </div>
          )}

          {inspectedData.zoomWarning && !inspectedData.isPlaceholder && (
            <div className="mb-4 p-2 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-[9px] text-amber-700 font-bold leading-tight uppercase">
                ⚠️ Low Zoom Accuracy
              </p>
              <p className="text-[8px] text-amber-600 mt-1 leading-tight">
                Zoom in to level 14+ for GIS-grade precision.
              </p>
            </div>
          )}
          
          <div className="space-y-3 font-mono text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Coordinates</span>
              <span className="text-slate-900 font-bold">{inspectedData.lngLat[1]}, {inspectedData.lngLat[0]}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Elevation</span>
              <span className="text-blue-600 font-black">{inspectedData.elevation} m</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Slope</span>
              <span className={`${inspectedData.riskColor} font-black`}>
                {inspectedData.slope !== 'N/A' ? `${inspectedData.slope}° (${inspectedData.riskLevel})` : 'N/A'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Aspect</span>
              <span className="text-slate-900 font-bold">{inspectedData.aspect}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">TRI (Ruggedness)</span>
              <span className="text-slate-900 font-bold">{inspectedData.tri}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Plan Curvature</span>
              <span className="text-purple-600 font-black">{inspectedData.curvature}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">TPI</span>
              <span className="text-indigo-600 font-black">{inspectedData.tpi} <span className="text-xs uppercase font-bold text-slate-400 ml-1">({inspectedData.tpiClass})</span></span>
            </div>

            {inspectedData.convergenceWarning && (
              <div className="mt-2 p-1.5 bg-cyan-50 border border-cyan-200 rounded text-[9px] text-cyan-700 font-bold uppercase tracking-wider text-center">
                ⚠️ Potential Water Accumulation Zone
              </div>
            )}
            
            <div className="flex justify-between mt-2 pt-2 border-t border-slate-100">
              <span className="text-slate-500">Land Cover (Armor)</span>
              <span className="text-slate-900 capitalize font-bold">{inspectedData.landCover} <span className="text-xs text-slate-400 uppercase">({inspectedData.armorLabel})</span></span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Dist to Road</span>
              <span className="text-amber-600 font-bold">{inspectedData.distRoad}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Dist to Water</span>
              <span className="text-cyan-600 font-bold">{inspectedData.distWater}</span>
            </div>

            {(inspectedData.smap || inspectedData.ndvi || inspectedData.et) && (
              <div className="mt-2 pt-2 border-t border-slate-100">
                <div className="text-[11px] text-slate-400 font-bold uppercase tracking-wider mb-1">NASA Satellite</div>
                {inspectedData.smap && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Soil Moisture</span>
                    <span className="text-orange-600 font-bold">{inspectedData.smap.mean} m³/m³</span>
                  </div>
                )}
                {inspectedData.ndvi && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">NDVI</span>
                    <span className="text-green-600 font-bold">{inspectedData.ndvi.ndvi}</span>
                  </div>
                )}
                {inspectedData.et && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">ET</span>
                    <span className="text-teal-600 font-bold">{inspectedData.et.et} mm/8d</span>
                  </div>
                )}
              </div>
            )}

            {inspectedData.rainfall && (
              <div className="mt-2 pt-2 border-t border-slate-100">
                <div className="text-[11px] text-slate-400 font-bold uppercase tracking-wider mb-1">Rainfall (NASA GPM)</div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Today</span>
                  <span className="text-blue-600 font-bold">{inspectedData.rainfall.today} mm</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">3-day</span>
                  <span className="text-blue-600 font-bold">{inspectedData.rainfall.d3} mm</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">7-day</span>
                  <span className="text-blue-700 font-bold">{inspectedData.rainfall.d7} mm</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">15-day</span>
                  <span className="text-blue-700 font-bold">{inspectedData.rainfall.d15} mm</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">30-day</span>
                  <span className="text-blue-800 font-bold">{inspectedData.rainfall.d30} mm</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Max daily</span>
                  <span className="text-red-600 font-bold">{inspectedData.rainfall.max} mm</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Wet days</span>
                  <span className="text-blue-600 font-bold">{inspectedData.rainfall.wetDays}/30</span>
                </div>
              </div>
            )}

            {inspectedData.slopeUnit && (
              <div className="mt-2 pt-2 border-t border-slate-100">
                <div className="text-[11px] text-slate-400 font-bold uppercase tracking-wider mb-1">Slope Unit</div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Mean Slope</span>
                  <span className="text-rose-600 font-bold">{inspectedData.slopeUnit.meanSlope}°</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Max Slope</span>
                  <span className="text-rose-600 font-bold">{inspectedData.slopeUnit.maxSlope}°</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Mean Elevation</span>
                  <span className="text-rose-600 font-bold">{inspectedData.slopeUnit.meanElev}m</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Elev Range</span>
                  <span className="text-rose-600 font-bold">{inspectedData.slopeUnit.elevRange}m</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Area</span>
                  <span className="text-rose-600 font-bold">{inspectedData.slopeUnit.areaKm2} km²</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Flow Accum</span>
                  <span className="text-rose-600 font-bold">{inspectedData.slopeUnit.flowAcc}</span>
                </div>
              </div>
            )}

            <div className="mt-2 pt-2 border-t border-slate-100">
              <div className="text-[11px] text-slate-400 font-bold uppercase tracking-wider mb-1">SoilGrids Data</div>
              <div className="flex justify-between">
                <span className="text-slate-500">Clay 0-5cm</span>
                <span className="text-amber-700 font-bold">{inspectedData.soilClay05 !== 'N/A' ? inspectedData.soilClay05 + '%' : 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Clay 5-15cm</span>
                <span className="text-amber-700 font-bold">{inspectedData.soilClay515 !== 'N/A' ? inspectedData.soilClay515 + '%' : 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Bulk 0-5cm</span>
                <span className="text-amber-700 font-bold">{inspectedData.soilBulk05 !== 'N/A' ? inspectedData.soilBulk05 + ' g/cm³' : 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Bulk 5-15cm</span>
                <span className="text-amber-700 font-bold">{inspectedData.soilBulk515 !== 'N/A' ? inspectedData.soilBulk515 + ' g/cm³' : 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">WRB Soil Group</span>
                <span className="text-amber-700 font-bold">{inspectedData.soilWrb}</span>
              </div>
            </div>

            {(() => {
              const missing = inspectedData.missingInputs || [];
              const fosBlocked = missing.length > 0 || !analysisComplete;
              const blockers = missing.length > 0 ? missing : ['Run Analyze'];
              return (
                <div className="pt-3 mt-3 border-t border-slate-200">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-800 font-bold uppercase tracking-wider text-[10px]">Factor of Safety</span>
                    <span className={`${fosBlocked ? 'text-slate-300' : inspectedData.lsiColor} font-black text-lg`}>
                      {fosBlocked ? '—' : inspectedData.lsi}
                    </span>
                  </div>
                  <div className="flex justify-between items-center mt-1">
                    <span className="text-[9px] text-slate-500">Risk Level</span>
                    <span className={`text-[10px] font-bold ${fosBlocked ? 'text-slate-300' : inspectedData.riskColor}`}>
                      {fosBlocked ? 'N/A' : inspectedData.riskLevel}
                    </span>
                  </div>
                  {fosBlocked ? (
                    <div className="mt-2 text-[8px] font-semibold text-slate-400 bg-slate-50 border border-slate-200 rounded px-2 py-1.5 leading-tight">
                      Needed: {blockers.join(', ')}
                    </div>
                  ) : (
                    <>
                      {inspectedData.fosComponents && (
                        <div className="mt-2 space-y-0.5 text-[8px] text-slate-400">
                          <div className="flex justify-between"><span>Soil: {inspectedData.soilParams?.name}</span><span>c'={inspectedData.soilParams?.c_prime?.toFixed(1)} kPa, phi={inspectedData.soilParams?.phi_prime?.toFixed(0)}</span></div>
                          <div className="flex justify-between"><span>Root cohesion</span><span>{inspectedData.rootCohesion?.toFixed(1)} kPa</span></div>
                          <div className="flex justify-between"><span>Saturation</span><span>{(inspectedData.saturation * 100)?.toFixed(0)}%</span></div>
                          <div className="flex justify-between"><span>Pore pressure</span><span>{inspectedData.fosComponents?.u?.toFixed(1)} kPa</span></div>
                        </div>
                      )}
                      {inspectedData.alerts && inspectedData.alerts.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {inspectedData.alerts.map((a, i) => (
                            <div key={i} className="text-[8px] font-bold text-red-600 bg-red-50 px-2 py-1 rounded">{a}</div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            <div className="mt-4 pt-3 border-t border-slate-100">
              <p className="text-[8px] text-slate-400 font-medium leading-tight uppercase tracking-tighter">
                Model: Infinite Slope (Skempton & DeLory 1957)
              </p>
              <p className="text-[7px] text-slate-300 italic mt-1 leading-tight">
                FoS &gt;1.5 Stable | 1.0-1.5 Monitor | &lt;1.0 Unstable
              </p>
            </div>
          </div>
        </div>
      )}

      {/* RIGHT PANEL - NASA SATELLITE EXPLORER */}
      {showSatellitePanel && (
        <div className="absolute top-0 right-0 h-full w-96 bg-white/95 backdrop-blur-xl border-l border-slate-200 z-10 shadow-2xl flex flex-col">
          {/* Header */}
          <div className="p-5 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h1 className="text-sm font-black text-slate-900 uppercase tracking-wider">NASA Satellite</h1>
              <p className="text-[9px] text-slate-400 mt-0.5">Earthdata Real-time Explorer</p>
            </div>
            <button onClick={() => setShowSatellitePanel(false)} className="text-slate-300 hover:text-slate-500 text-lg leading-none">&times;</button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {/* FETCH CONTROLS */}
            <div className="p-5 border-b border-slate-100">
              <div className="flex gap-2 mb-3">
                <div className="flex-1">
                  <label className="block text-[9px] font-bold text-slate-400 uppercase mb-1">Date</label>
                  <input type="date" value={fetchDate} onChange={(e) => setFetchDate(e.target.value)}
                    className="w-full p-2 bg-slate-50 border border-slate-200 rounded text-xs font-mono text-slate-700 outline-none focus:border-indigo-500" />
                </div>
                <div className="w-24">
                  <label className="block text-[9px] font-bold text-slate-400 uppercase mb-1">Period</label>
                  <select value={fetchPeriod} onChange={(e) => setFetchPeriod(Number(e.target.value))}
                    className="w-full p-2 bg-slate-50 border border-slate-200 rounded text-xs text-slate-700 outline-none focus:border-indigo-500">
                    <option value={15}>15d</option>
                    <option value={30}>30d</option>
                    <option value={60}>60d</option>
                    <option value={90}>90d</option>
                  </select>
                </div>
              </div>
              <button
                onClick={() => {
                  setIsFetching(true);
                  setDataLoaded(false);
                  setAnalysisComplete(false);
                  setActiveNasaLayer(null);
                  setFetchProgress({ step: 'Connecting...', percent: 0 });
                  
                  const dateStr = fetchDate.replace(/-/g, '');
                  const sseUrl = `${API_BASE}/api/fetch-stream?end_date=${dateStr}&days=${fetchPeriod}`;
                  const es = new EventSource(sseUrl);

                  es.addEventListener('progress', (e) => {
                    try {
                      const data = JSON.parse(e.data);
                      if (data.step === 'error') {
                        setFetchProgress({ step: `ERROR: ${data.status}`, percent: data.pct });
                        return;
                      }
                      setFetchProgress({
                        step: `${data.step.toUpperCase()}: ${data.status}`,
                        percent: data.pct
                      });
                    } catch (err) {
                      console.error('Failed to parse progress event', err);
                    }
                  });

                  es.addEventListener('data', (e) => {
                    let data;
                    try {
                      data = JSON.parse(e.data);
                    } catch (err) {
                      console.error('Failed to parse data event', err);
                      return;
                    }
                    // Update daily series FIRST — independent of map, must not be blocked by map errors
                    if (data.key === 'rainfall' && data.daily_series) {
                      setDailySeries(data.daily_series);
                    }
                    if (data.key === 'smap' && data.smap_daily) {
                      setSmapSeries(data.smap_daily);
                    }
                    // Store features for bottom panel tables
                    if (data.geojson && data.geojson.features) {
                      setNasaFeatures(prev => ({ ...prev, [data.key]: data.geojson.features }));
                    }
                    // Update map separately so a map error doesn't suppress state updates above
                    if (data.geojson) {
                      // slope-units source has no '-data' suffix
                      const sourceId = data.key === 'slope-units' ? 'slope-units' : `${data.key}-data`;
                      if (map.current?.getSource(sourceId)) {
                        try {
                          map.current.getSource(sourceId).setData(data.geojson);
                        } catch (mapErr) {
                          console.error('Map setData failed:', mapErr);
                        }
                      }
                    }
                  });

                  es.addEventListener('done', () => {
                    setDataLoaded(true);
                    setIsFetching(false);
                    es.close();
                    loadCacheInfo();
                  });

                  es.addEventListener('error', (e) => {
                    console.error("SSE Error:", e);
                    const reason = es.readyState === EventSource.CLOSED
                      ? 'Connection closed by server'
                      : 'Connection to backend lost — is the server running?';
                    setFetchProgress({ step: reason, percent: 0 });
                    setIsFetching(false);
                    es.close();
                  });
                }}
                disabled={isFetching}
                className={`w-full py-2.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${isFetching ? 'bg-indigo-400 text-white' : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-600/25'}`}
              >
                {isFetching ? `${fetchProgress.step} · ${fetchProgress.percent}%` : 'Fetch All Data'}
              </button>
              {isFetching && (
                <div className="mt-2 w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 rounded-full transition-all duration-500" style={{ width: `${fetchProgress.percent}%` }} />
                </div>
              )}
              {!isFetching && cachedDays && (
                <div className="mt-2 flex items-center gap-1.5">
                  {cachedDays.cached === cachedDays.total ? (
                    <span className="text-[9px] text-emerald-600 font-bold">✓ All {cachedDays.total} days cached — no download needed</span>
                  ) : cachedDays.cached > 0 ? (
                    <span className="text-[9px] text-amber-600 font-bold">↓ {cachedDays.cached}/{cachedDays.total} days cached · {cachedDays.total - cachedDays.cached} to download</span>
                  ) : (
                    <span className="text-[9px] text-slate-400">↓ {cachedDays.total} days to download</span>
                  )}
                </div>
              )}
            </div>

            {/* LAYER CARDS - only show after data loaded */}
            {dataLoaded && (
              <div className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Layers</span>
                  <button
                    onClick={() => setHoverEnabled(v => !v)}
                    className={`px-2.5 py-1 rounded text-[8px] font-bold uppercase tracking-wider transition-colors ${hoverEnabled ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-400'}`}
                  >{hoverEnabled ? 'Hover ON' : 'Hover OFF'}</button>
                </div>
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {[
                    { key: 'rainfall', label: 'Rainfall', sub: 'GPM IMERG', color: 'blue', icon: '🌧' },
                    { key: 'smap', label: 'Soil Moisture', sub: 'SMAP L-band', color: 'orange', icon: '💧' },
                    { key: 'ndvi', label: 'Vegetation', sub: 'VIIRS NDVI', color: 'green', icon: '🌿' },
                    { key: 'et', label: 'Evapotrans.', sub: 'VIIRS ET', color: 'teal', icon: '☀' },
                  ].map(layer => {
                    const isActive = activeNasaLayer === layer.key;
                    const colorMap = { blue: 'border-blue-500 bg-blue-50', orange: 'border-orange-500 bg-orange-50', green: 'border-green-500 bg-green-50', teal: 'border-teal-500 bg-teal-50' };
                    return (
                      <button key={layer.key}
                        onClick={() => setActiveNasaLayer(isActive ? null : layer.key)}
                        className={`p-3 rounded-lg border-2 text-left transition-all ${isActive ? colorMap[layer.color] : 'border-slate-100 bg-white hover:border-slate-200 hover:bg-slate-50'}`}
                      >
                        <div className="text-lg mb-1">{layer.icon}</div>
                        <div className="text-[11px] font-bold text-slate-800">{layer.label}</div>
                        <div className="text-[9px] text-slate-400">{layer.sub}</div>
                      </button>
                    );
                  })}
                </div>

                {/* Rainfall sub-options */}
                {activeNasaLayer === 'rainfall' && (() => {
                  const dates = dailySeries.map(d => d.date);
                  const isDaily = rainfallMetric.startsWith('d_');
                  const selectedDate = isDaily ? rainfallMetric.slice(2) : dates[dates.length - 1] || '';
                  const dateIdx = dates.indexOf(selectedDate);
                  const fmtDate = (d) => d ? `${d.slice(4,6)}/${d.slice(6)}` : '—';
                  const btnClass = (active) => `py-1.5 rounded text-[10px] font-bold transition-colors ${active ? 'bg-blue-500 text-white' : 'bg-white text-slate-500 hover:bg-blue-100'}`;

                  return (
                    <div className="mb-4 p-3 bg-blue-50 rounded-lg">
                      <p className="text-[9px] font-bold text-blue-400 uppercase mb-2">Rainfall View</p>
                      <div className="grid grid-cols-3 gap-1">
                        {/* Day picker button */}
                        <div className={`flex items-center rounded overflow-hidden ${isDaily ? 'ring-2 ring-blue-500' : ''}`}>
                          <button
                            onClick={() => { const i = Math.max(0, (dateIdx > 0 ? dateIdx : dates.length) - 1); if (dates[i]) setRainfallMetric(`d_${dates[i]}`); }}
                            className="px-1.5 py-1.5 bg-white text-slate-400 hover:bg-blue-100 text-[9px] font-bold"
                          >&lt;</button>
                          <select
                            value={selectedDate}
                            onChange={(e) => setRainfallMetric(`d_${e.target.value}`)}
                            className={`flex-1 text-center text-[10px] font-bold py-1.5 border-0 outline-none cursor-pointer ${isDaily ? 'bg-blue-500 text-white' : 'bg-white text-slate-500'}`}
                          >
                            {dates.map(d => <option key={d} value={d}>{fmtDate(d)}</option>)}
                            {!dates.length && <option value="">—</option>}
                          </select>
                          <button
                            onClick={() => { const i = Math.min(dates.length - 1, dateIdx + 1); if (dates[i]) setRainfallMetric(`d_${dates[i]}`); }}
                            className="px-1.5 py-1.5 bg-white text-slate-400 hover:bg-blue-100 text-[9px] font-bold"
                          >&gt;</button>
                        </div>
                        <button onClick={() => setRainfallMetric('rain_3d')} className={btnClass(rainfallMetric === 'rain_3d')}>3 day</button>
                        <button onClick={() => setRainfallMetric('rain_7d')} className={btnClass(rainfallMetric === 'rain_7d')}>7 day</button>
                        <button onClick={() => setRainfallMetric('rain_15d')} className={btnClass(rainfallMetric === 'rain_15d')}>15 day</button>
                        <button onClick={() => setRainfallMetric('rain_30d')} className={btnClass(rainfallMetric === 'rain_30d')}>30 day</button>
                        <button onClick={() => setRainfallMetric('rain_max')} className={btnClass(rainfallMetric === 'rain_max')}>Max</button>
                      </div>
                    </div>
                  );
                })()}

                {/* Legend for active layer */}
                {activeNasaLayer && (() => {
                  const legends = {
                    rainfall: {
                      rain_today: { gradient: '#f7fbff, #c6dbef, #6baed6, #2171b5, #08306b', stops: ['0', '5', '15', '30', '60 mm'], label: 'Today' },
                      rain_3d:    { gradient: '#f7fbff, #c6dbef, #6baed6, #2171b5, #08306b', stops: ['0', '10', '30', '60', '120 mm'], label: '3-day' },
                      rain_7d:    { gradient: '#ffffcc, #a1dab4, #41b6c4, #2c7fb8, #253494', stops: ['0', '20', '50', '100', '200 mm'], label: '7-day' },
                      rain_15d:   { gradient: '#ffffcc, #a1dab4, #41b6c4, #2c7fb8, #253494', stops: ['0', '40', '100', '200', '400 mm'], label: '15-day' },
                      rain_30d:   { gradient: '#ffffcc, #a1dab4, #41b6c4, #2c7fb8, #253494', stops: ['0', '80', '160', '300', '500 mm'], label: '30-day' },
                      rain_max:   { gradient: '#f7fbff, #c6dbef, #6baed6, #2171b5, #08306b', stops: ['0', '10', '30', '60', '120 mm'], label: 'Max daily' },
                    },
                  };
                  let grad, stops, unit;
                  if (activeNasaLayer === 'rainfall') {
                    const isDaily = rainfallMetric.startsWith('d_');
                    const cfg = isDaily
                      ? { gradient: '#f7fbff, #c6dbef, #6baed6, #2171b5, #08306b', stops: ['0', '5', '15', '30', '60 mm'], label: rainfallMetric.slice(2).replace(/(\d{4})(\d{2})(\d{2})/, '$2/$3') }
                      : (legends.rainfall[rainfallMetric] || legends.rainfall.rain_7d);
                    grad = cfg.gradient; stops = cfg.stops; unit = isDaily ? `Daily rainfall — ${cfg.label}` : cfg.label + ' cumulative';
                  } else if (activeNasaLayer === 'smap') {
                    grad = '#fff7ec, #fee8c8, #fdd49e, #fdbb84, #fc8d59, #e34a33, #b30000';
                    stops = ['0.05', '0.15', '0.25', '0.40 m\u00B3/m\u00B3']; unit = 'Soil moisture';
                  } else if (activeNasaLayer === 'ndvi') {
                    grad = '#d73027, #fc8d59, #fee08b, #d9ef8b, #1a9850, #006837';
                    stops = ['0.0 Bare', '0.2', '0.4', '0.6', '0.8', '1.0 Dense']; unit = 'NDVI';
                  } else {
                    grad = '#f7fcf0, #c7e9b4, #7fcdbb, #41b6c4, #1d91c0, #0c2c84';
                    stops = ['0', '10', '20', '30', '40', '50 mm/8d']; unit = 'Evapotranspiration';
                  }
                  return (
                    <div className="mb-4">
                      <div className="text-[8px] text-slate-500 font-bold uppercase tracking-wider mb-1">{unit}</div>
                      <div className="h-3 rounded" style={{background: `linear-gradient(to right, ${grad})`}} />
                      <div className="flex justify-between text-[8px] text-slate-400 font-mono mt-0.5">
                        {stops.map((s, i) => <span key={i}>{s}</span>)}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

          </div>

          {/* ANALYZE LANDSLIDE RISK */}
          <div className="p-5 border-t border-slate-200">
            <button
              onClick={() => {
                setIsAnalyzing(true);
                setAnalysisComplete(false);
                setAnalysisProgress('Connecting...');
                const es = new EventSource(`${API_BASE}/api/analyze-fos`);
                es.addEventListener('progress', (e) => {
                  try {
                    const d = JSON.parse(e.data);
                    setAnalysisProgress(`${d.status} (${d.pct}%)`);
                  } catch (_) {}
                });
                es.addEventListener('data', (e) => {
                  try {
                    const d = JSON.parse(e.data);
                    if (d.key === 'slope-units' && d.geojson) {
                      if (map.current?.getSource('slope-units')) {
                        map.current.getSource('slope-units').setData(d.geojson);
                      }
                      setNasaFeatures(prev => ({ ...prev, 'slope-units': d.geojson.features }));
                    }
                  } catch (_) {}
                });
                es.addEventListener('done', () => {
                  setIsAnalyzing(false);
                  setAnalysisComplete(true);
                  setShowSlopeUnits(true);
                  setSlopeUnitColor('fos');
                  setActiveNasaLayer(null);
                  setAnalysisProgress('');
                  es.close();
                });
                es.addEventListener('error', () => {
                  setIsAnalyzing(false);
                  setAnalysisProgress('Error');
                  es.close();
                });
              }}
              disabled={!dataLoaded || isAnalyzing}
              className={`w-full py-3 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${
                !dataLoaded
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : analysisComplete
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : isAnalyzing
                      ? 'bg-red-400 text-white'
                      : 'bg-red-600 text-white hover:bg-red-700 animate-pulse ring-4 ring-red-300 ring-offset-2 scale-105 shadow-xl shadow-red-600/50'
              }`}
            >
              {!dataLoaded
                ? 'Fetch Data to Analyze'
                : isAnalyzing
                  ? analysisProgress
                  : analysisComplete
                    ? 'Analysis Complete — Run Again'
                    : '▶ Run Analysis'}
            </button>
          </div>

          {/* CACHE MANAGER */}
          <div className="border-t border-slate-100">
            <button
              onClick={() => setShowCacheManager(v => !v)}
              className="w-full px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors"
            >
              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Cache Manager</span>
              <div className="flex items-center gap-2">
                {cacheInfo && (
                  <span className="text-[9px] text-slate-400 font-mono">
                    {fmtBytes(Object.values(cacheInfo).flat().reduce((s, f) => s + f.size, 0))}
                  </span>
                )}
                <span className="text-slate-300 text-xs">{showCacheManager ? '▲' : '▼'}</span>
              </div>
            </button>

            {showCacheManager && cacheInfo && (
              <div className="px-4 pb-4 space-y-4">
                {[
                  { key: 'rainfall', label: 'Rainfall (GPM)',         color: 'blue'   },
                  { key: 'smap',     label: 'Soil Moisture (SMAP)',   color: 'orange' },
                  { key: 'ndvi',     label: 'Vegetation (NDVI)',      color: 'green'  },
                  { key: 'et',       label: 'Evapotransp. (ET)',      color: 'teal'   },
                ].map(({ key, label, color }) => {
                  const files = cacheInfo[key] || [];
                  const totalBytes = files.reduce((s, f) => s + f.size, 0);
                  const sel = selectedCache[key];
                  const allSelected = files.length > 0 && sel.length === files.length;

                  return (
                    <div key={key}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                          {label} · {files.length} files · {fmtBytes(totalBytes)}
                        </span>
                        <button
                          onClick={() => setSelectedCache(prev => ({
                            ...prev,
                            [key]: allSelected ? [] : files.map(f => f.date)
                          }))}
                          className="text-[9px] text-indigo-500 hover:text-indigo-700 font-bold"
                        >
                          {allSelected ? 'Deselect all' : 'Select all'}
                        </button>
                      </div>

                      {files.length === 0 ? (
                        <p className="text-[9px] text-slate-300 italic px-1">No cached files</p>
                      ) : (
                        <div className="max-h-36 overflow-y-auto space-y-0.5">
                          {files.map(f => (
                            <label key={f.date} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-slate-50 cursor-pointer">
                              <input
                                type="checkbox"
                                className="accent-indigo-500"
                                checked={sel.includes(f.date)}
                                onChange={e => setSelectedCache(prev => ({
                                  ...prev,
                                  [key]: e.target.checked
                                    ? [...prev[key], f.date]
                                    : prev[key].filter(d => d !== f.date)
                                }))}
                              />
                              <span className="text-[10px] font-mono text-slate-600 flex-1">
                                {`${f.date.slice(0,4)}/${f.date.slice(4,6)}/${f.date.slice(6)}`}
                              </span>
                              <span className="text-[9px] text-slate-400">{fmtBytes(f.size)}</span>
                            </label>
                          ))}
                        </div>
                      )}

                      {sel.length > 0 && (
                        <button
                          disabled={isDeletingCache}
                          onClick={async () => {
                            setIsDeletingCache(true);
                            try {
                              await fetch(`${API_BASE}/api/cache-delete`, {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ type: key, dates: sel }),
                              });
                              await loadCacheInfo();
                              setSelectedCache(prev => ({ ...prev, [key]: [] }));
                            } catch (e) {
                              console.error('Delete failed', e);
                            }
                            setIsDeletingCache(false);
                          }}
                          className="mt-1.5 w-full py-1.5 rounded text-[9px] font-bold uppercase tracking-wider bg-red-50 text-red-500 hover:bg-red-100 disabled:opacity-50 transition-colors"
                        >
                          {isDeletingCache ? 'Deleting...' : `Delete ${sel.length} selected (${fmtBytes(files.filter(f => sel.includes(f.date)).reduce((s, f) => s + f.size, 0))})`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="p-2 border-t border-slate-100 text-center">
            <p className="text-[7px] text-slate-300">NASA Earthdata | GPM v07 | SMAP v006 | VIIRS v002</p>
          </div>
        </div>
      )}

      {/* BOTTOM DATA PANEL */}
      {dataLoaded && (
        <div className={`absolute bottom-0 z-10 transition-all`}
          style={{ left: 320, right: showSatellitePanel ? 384 : 0 }}>
          {/* Toggle bar */}
          <div className="flex items-center bg-white/95 backdrop-blur border-t border-slate-200 shadow-lg">
            <button onClick={() => setShowBottomPanel(v => !v)}
              className="px-3 py-1.5 text-[8px] font-bold text-slate-400 uppercase tracking-wider hover:text-slate-600">
              {showBottomPanel ? 'Hide Data' : 'Show Data'}
            </button>
            {showBottomPanel && (
              <div className="flex gap-0.5 flex-1">
                {[
                  { key: 'rainfall', label: 'Rainfall' },
                  { key: 'smap', label: 'SMAP' },
                  { key: 'ndvi', label: 'NDVI' },
                  { key: 'et', label: 'ET' },
                ].map(t => (
                  <button key={t.key} onClick={() => setBottomTab(t.key)}
                    className={`px-3 py-1.5 text-[9px] font-bold uppercase transition-colors ${bottomTab === t.key ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                  >{t.label}</button>
                ))}
              </div>
            )}
            {showBottomPanel && (
              <button
                onClick={() => {
                  const features = nasaFeatures[bottomTab] || [];
                  if (!features.length) return;
                  const allProps = features.map(f => {
                    const c = f.geometry.coordinates[0];
                    return { lat: ((c[0][1]+c[2][1])/2).toFixed(4), lon: ((c[0][0]+c[1][0])/2).toFixed(4), ...f.properties };
                  });
                  const keys = Object.keys(allProps[0]);
                  const header = keys.join(',') + '\n';
                  const rows = allProps.map(p => keys.map(k => p[k] ?? '').join(',')).join('\n');
                  const blob = new Blob([header + rows], { type: 'text/csv' });
                  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
                  a.download = `${bottomTab}_percell.csv`; a.click();
                }}
                className="px-3 py-1.5 text-[8px] font-bold text-indigo-500 hover:text-indigo-700 uppercase"
              >CSV</button>
            )}
          </div>

          {/* Table content */}
          {showBottomPanel && (() => {
            const features = nasaFeatures[bottomTab] || [];
            if (!features.length) return (
              <div className="bg-white/95 backdrop-blur border-t border-slate-100 p-4 text-center text-[10px] text-slate-400 italic h-[180px]">
                No {bottomTab} data loaded
              </div>
            );

            const allProps = features.map(f => {
              const c = f.geometry.coordinates[0];
              const cLat = ((c[0][1] + c[2][1]) / 2).toFixed(4);
              const cLon = ((c[0][0] + c[1][0]) / 2).toFixed(4);
              return { lat: cLat, lon: cLon, ...f.properties };
            }).sort((a, b) => b.lat - a.lat || a.lon - b.lon);

            const sampleProps = allProps[0] || {};
            const dailyKeys = Object.keys(sampleProps).filter(k => k.startsWith('d_')).sort();
            const hasFlags = bottomTab === 'smap' && Object.keys(sampleProps).some(k => k.startsWith('f_'));
            let summaryKeys, columns;

            if (bottomTab === 'rainfall') {
              summaryKeys = ['rain_today', 'rain_3d', 'rain_7d', 'rain_15d', 'rain_30d', 'rain_max'];
              columns = ['lat', 'lon', ...dailyKeys, ...summaryKeys];
            } else if (bottomTab === 'smap') {
              summaryKeys = ['sm_mean', 'sm_latest', 'sm_max', 'sm_min', 'n_obs'];
              columns = ['lat', 'lon', ...dailyKeys, ...summaryKeys];
            } else if (bottomTab === 'ndvi') {
              summaryKeys = ['ndvi', 'date'];
              columns = ['lat', 'lon', ...summaryKeys];
            } else {
              summaryKeys = ['et', 'date'];
              columns = ['lat', 'lon', ...summaryKeys];
            }

            const fmtCol = (k) => k.startsWith('d_') ? k.slice(6,8)+'/'+k.slice(8) : k;

            return (
              <div className="bg-white/95 backdrop-blur border-t border-slate-100" style={{ height: 180 }}>
                <div className="h-full overflow-auto">
                  <table className="w-full text-[10px] font-mono" style={{ minWidth: columns.length * 70 }}>
                    <thead className="sticky top-0 bg-slate-100 border-b border-slate-300 z-10">
                      <tr>
                        {columns.map(k => (
                          <th key={k} className="px-2 py-1.5 text-left font-bold text-slate-500 whitespace-nowrap">{fmtCol(k)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {allProps.map((row, idx) => (
                        <tr key={idx} className="border-b border-slate-50 hover:bg-indigo-50/30">
                          {columns.map(k => {
                            const val = row[k];
                            const isInterp = hasFlags && k.startsWith('d_') && row[`f_${k.slice(2)}`] === 'I';
                            return (
                              <td key={k} className={`px-2 py-1 whitespace-nowrap ${isInterp ? 'text-orange-400 italic' : 'text-slate-600'}`}>
                                {val ?? '-'}{isInterp ? '*' : ''}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="absolute bottom-1 right-3 text-[8px] text-slate-300">
                  {allProps.length} rows{hasFlags ? ' · *interpolated' : ''}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Toggle satellite panel */}
      {!showSatellitePanel && (
        <button onClick={() => setShowSatellitePanel(true)}
          className="absolute top-4 right-4 z-20 bg-indigo-600 text-white px-4 py-2 rounded-lg shadow-lg text-[10px] font-bold uppercase tracking-wider hover:bg-indigo-700 transition-colors">
          NASA Data
        </button>
      )}

    </div>
  );
};

export default App;