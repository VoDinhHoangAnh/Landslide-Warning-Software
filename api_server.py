"""
FastAPI backend for Lao Cai Landslide Analysis.
SSE streaming endpoint for real-time progress during NASA data fetch.
Run: uvicorn api_server:app --port 8000
"""

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse
import json
import os
import sys
import glob
import asyncio
from datetime import datetime, timedelta

app = FastAPI(title="Lao Cai Landslide API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

sys.path.insert(0, os.path.dirname(__file__))
PUBLIC = "C:/Users/024792/Downloads/landslide/public"


def _build_rainfall(end_date, days):
    """Build rainfall GeoJSON + daily series. Yields progress events."""
    from fetch_rainfall import find_granule_urls, download_granule, extract_precip
    import numpy as np

    end_dt = datetime.strptime(end_date, "%Y%m%d")
    start_dt = end_dt - timedelta(days=days - 1)

    yield {"step": "rainfall", "status": "Searching NASA CMR...", "pct": 1}

    granules = find_granule_urls(start_dt, end_dt)
    total = len(granules)
    if total == 0:
        yield {"step": "rainfall", "status": "No data found", "pct": 25}
        yield (None, [])
        return

    yield {"step": "rainfall", "status": f"Found {total} daily files", "pct": 2}

    nc4_files = {}
    for i, g in enumerate(granules):
        cached = os.path.exists(os.path.join("C:/Users/024792/Downloads/landslide/rainfall_cache", f"imerg_{g['date']}.nc4"))
        status = f"{'Reading' if cached else 'Downloading'} {g['date']} ({i+1}/{total})"
        yield {"step": "rainfall", "status": status, "pct": 2 + int((i / total) * 18)}
        path = download_granule(g)
        nc4_files[g["date"]] = path

    yield {"step": "rainfall", "status": "Extracting precipitation grid...", "pct": 21}

    all_precip = {}
    lats = lons = None
    sorted_dates = sorted(nc4_files.keys())
    for date_str in sorted_dates:
        precip, lats, lons = extract_precip(nc4_files[date_str])
        all_precip[date_str] = precip

    yield {"step": "rainfall", "status": "Computing antecedent metrics...", "pct": 23}

    precip_stack = np.stack([all_precip[d] for d in sorted_dates], axis=0)
    rain_today = all_precip[sorted_dates[-1]]
    n = len(sorted_dates)
    rain_3d = precip_stack[-min(3, n):].sum(axis=0)
    rain_7d = precip_stack[-min(7, n):].sum(axis=0)
    rain_15d = precip_stack[-min(15, n):].sum(axis=0)
    rain_30d = precip_stack.sum(axis=0)
    rain_max = precip_stack.max(axis=0)
    rain_mean = precip_stack.mean(axis=0)
    wet_days = (precip_stack > 1.0).sum(axis=0)

    daily_series = []
    for d in sorted_dates:
        daily_series.append({
            "date": d,
            "mean": round(float(all_precip[d].mean()), 2),
            "max": round(float(all_precip[d].max()), 1),
            "min": round(float(all_precip[d][all_precip[d] > 0].min()), 1) if (all_precip[d] > 0).any() else 0
        })

    res = 0.1
    features = []
    for i, lat in enumerate(lats):
        for j, lon in enumerate(lons):
            features.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [[
                    [round(float(lon)-res/2,3), round(float(lat)-res/2,3)],
                    [round(float(lon)+res/2,3), round(float(lat)-res/2,3)],
                    [round(float(lon)+res/2,3), round(float(lat)+res/2,3)],
                    [round(float(lon)-res/2,3), round(float(lat)+res/2,3)],
                    [round(float(lon)-res/2,3), round(float(lat)-res/2,3)]
                ]]},
                "properties": {
                    "rain_today": round(float(rain_today[i,j]),1),
                    "rain_3d": round(float(rain_3d[i,j]),1),
                    "rain_7d": round(float(rain_7d[i,j]),1),
                    "rain_15d": round(float(rain_15d[i,j]),1),
                    "rain_30d": round(float(rain_30d[i,j]),1),
                    "rain_max": round(float(rain_max[i,j]),1),
                    "rain_mean": round(float(rain_mean[i,j]),2),
                    "wet_days": int(wet_days[i,j]),
                    "date": sorted_dates[-1],
                    **{f"d_{d}": round(float(all_precip[d][i,j]),1) for d in sorted_dates}
                }
            })

    geojson = {"type": "FeatureCollection", "features": features}
    yield {"step": "rainfall", "status": "Complete", "pct": 25}
    yield (geojson, daily_series)


def _build_smap(end_date, days):
    """Build SMAP GeoJSON + daily series. Yields progress events."""
    from fetch_smap import find_smap_granules, download_smap_granule, extract_smap
    import numpy as np

    MAX_SMAP_GRANULES = 30  # With Harmony subsetting, each file is ~1.4MB (not 600MB)

    end_dt = datetime.strptime(end_date, "%Y%m%d")
    start_dt = end_dt - timedelta(days=days - 1)

    yield {"step": "smap", "status": "Searching NASA CMR...", "pct": 26}

    granules = find_smap_granules(start_dt, end_dt)
    if not granules:
        yield {"step": "smap", "status": "No SMAP data found", "pct": 50}
        yield (None, [])
        return

    # Take only most recent N granules (each ~600MB global file)
    if len(granules) > MAX_SMAP_GRANULES:
        granules = granules[-MAX_SMAP_GRANULES:]
    total = len(granules)

    yield {"step": "smap", "status": f"Found {total} SMAP files", "pct": 27}

    all_sm = {}
    lats = lons = None
    for i, g in enumerate(granules):
        cache_path = os.path.join("C:/Users/024792/Downloads/landslide/smap_cache", f"smap_{g['date']}.h5")
        cached = os.path.exists(cache_path) and os.path.getsize(cache_path) > 0
        status = f"{'Cached' if cached else 'Downloading'} {g['date']} ({i+1}/{total})"
        yield {"step": "smap", "status": status, "pct": 27 + int((i / total) * 18)}
        try:
            path = download_smap_granule(g)
            sm, la, lo = extract_smap(path)
            if sm is not None:
                all_sm[g["date"]] = sm
                if lats is None:
                    lats, lons = la, lo
        except Exception as e:
            yield {"step": "smap", "status": f"Error {g['date']}: {e}", "pct": 27 + int((i / total) * 18)}

    if not all_sm:
        yield {"step": "smap", "status": "No valid SMAP data extracted", "pct": 50}
        yield (None, [])
        return

    yield {"step": "smap", "status": "Interpolating gaps with rainfall...", "pct": 47}

    sorted_dates = sorted(all_sm.keys())
    nrows, ncols = lats.shape

    # --- Load rainfall for the same period to inform interpolation ---
    from fetch_rainfall import find_granule_urls, download_granule, extract_precip
    rain_daily = {}  # date -> 2D array of precip
    try:
        rf_granules = find_granule_urls(start_dt, end_dt)
        for g in rf_granules:
            try:
                path = download_granule(g)
                precip, rf_lats, rf_lons = extract_precip(path)
                rain_daily[g["date"]] = (precip, rf_lats, rf_lons)
            except Exception:
                pass
    except Exception:
        pass

    def _get_rain_at(lat_val, lon_val, date_str):
        """Lookup daily rainfall (mm) at a lat/lon from the rainfall grid."""
        if date_str not in rain_daily:
            return 0.0
        precip, rf_lats, rf_lons = rain_daily[date_str]
        # Find nearest rainfall cell
        lat_idx = int(np.argmin(np.abs(rf_lats - lat_val)))
        lon_idx = int(np.argmin(np.abs(rf_lons - lon_val)))
        return float(precip[lat_idx, lon_idx])

    # --- Build full date range (every day) ---
    all_dates = []
    d = start_dt
    while d <= end_dt:
        all_dates.append(d.strftime("%Y%m%d"))
        d += timedelta(days=1)

    # --- Rainfall-informed interpolation per cell ---
    # Parameters
    WETTING_RATE = 0.008   # sm increase per mm of rain (empirical: ~0.008 m³/m³ per mm)
    DRYING_RATE = 0.003    # sm decrease per dry day (evaporation/drainage)
    SM_MAX = 0.50          # physical upper bound for soil moisture

    interp_stack = np.full((len(all_dates), nrows, ncols), np.nan)
    flag_stack = np.full((len(all_dates), nrows, ncols), '', dtype='U1')

    for i in range(nrows):
        for j in range(ncols):
            lat_val = float(lats[i, j])
            lon_val = float(lons[i, j])
            if np.isnan(lat_val) or np.isnan(lon_val):
                continue

            # Collect measured values for this cell
            measured = {}  # date_str -> value
            for d in sorted_dates:
                v = float(all_sm[d][i, j])
                if not np.isnan(v):
                    measured[d] = v

            if not measured:
                continue

            measured_dates = sorted(measured.keys())
            first_m = measured_dates[0]
            last_m = measured_dates[-1]

            for t, date_str in enumerate(all_dates):
                if date_str in measured:
                    # Measured value — use as-is
                    interp_stack[t, i, j] = measured[date_str]
                    flag_stack[t, i, j] = 'M'
                elif date_str < first_m or date_str > last_m:
                    # Outside measured range — nearest neighbor
                    nearest = first_m if date_str < first_m else last_m
                    interp_stack[t, i, j] = measured[nearest]
                    flag_stack[t, i, j] = 'I'
                else:
                    # Between two measurements — rainfall-informed interpolation
                    # Find bounding measurements
                    prev_d = max(d for d in measured_dates if d <= date_str)
                    next_d = min(d for d in measured_dates if d >= date_str)
                    if prev_d == next_d:
                        interp_stack[t, i, j] = measured[prev_d]
                        flag_stack[t, i, j] = 'M'
                        continue

                    prev_v = measured[prev_d]
                    next_v = measured[next_d]

                    # Linear interpolation base
                    prev_idx = all_dates.index(prev_d)
                    next_idx = all_dates.index(next_d)
                    t_frac = (t - prev_idx) / (next_idx - prev_idx)
                    linear_val = prev_v + t_frac * (next_v - prev_v)

                    # Rainfall adjustment: accumulate rain effect from prev measurement
                    rain_effect = 0.0
                    for k in range(prev_idx + 1, t + 1):
                        daily_rain = _get_rain_at(lat_val, lon_val, all_dates[k])
                        if daily_rain > 0.5:  # meaningful rain
                            rain_effect += daily_rain * WETTING_RATE
                        else:
                            rain_effect -= DRYING_RATE

                    adjusted = linear_val + rain_effect
                    # Clamp to physical bounds
                    adjusted = max(0.0, min(SM_MAX, adjusted))
                    interp_stack[t, i, j] = adjusted
                    flag_stack[t, i, j] = 'I'

    yield {"step": "smap", "status": "Building GeoJSON...", "pct": 49}

    # Compute summary stats from interpolated stack
    mean_sm = np.nanmean(interp_stack, axis=0)
    max_sm = np.nanmax(interp_stack, axis=0)
    min_sm = np.nanmin(interp_stack, axis=0)
    latest = interp_stack[-1]
    res_lon = float(abs(lons[0, 1] - lons[0, 0])) if lons.shape[1] > 1 else 0.09
    res_lat = float(abs(lats[1, 0] - lats[0, 0])) if lats.shape[0] > 1 else 0.09

    # Build daily series for overview
    smap_daily = []
    for t, d in enumerate(all_dates):
        layer = interp_stack[t]
        valid = layer[~np.isnan(layer)]
        if len(valid) > 0:
            n_measured = np.sum(flag_stack[t] == 'M')
            smap_daily.append({
                "date": d,
                "mean": round(float(np.mean(valid)), 3),
                "max": round(float(np.max(valid)), 3),
                "min": round(float(np.min(valid)), 3),
                "n_measured": int(n_measured),
            })

    features = []
    for i in range(nrows):
        for j in range(ncols):
            lat = float(lats[i, j])
            lon = float(lons[i, j])
            sm_mean_val = float(mean_sm[i, j]) if not np.isnan(mean_sm[i, j]) else None
            if sm_mean_val is None:
                continue
            sm_latest = float(latest[i, j]) if not np.isnan(latest[i, j]) else None
            sm_max_val = float(max_sm[i, j]) if not np.isnan(max_sm[i, j]) else None
            sm_min_val = float(min_sm[i, j]) if not np.isnan(min_sm[i, j]) else None

            daily_props = {}
            for t, d in enumerate(all_dates):
                v = interp_stack[t, i, j]
                f = flag_stack[t, i, j]
                if not np.isnan(v):
                    daily_props[f"d_{d}"] = round(float(v), 3)
                    daily_props[f"f_{d}"] = f
                else:
                    daily_props[f"d_{d}"] = None
                    daily_props[f"f_{d}"] = ''

            n_obs = int(np.sum(flag_stack[:, i, j] == 'M'))
            features.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [[
                    [round(lon-res_lon/2,4), round(lat-res_lat/2,4)],
                    [round(lon+res_lon/2,4), round(lat-res_lat/2,4)],
                    [round(lon+res_lon/2,4), round(lat+res_lat/2,4)],
                    [round(lon-res_lon/2,4), round(lat+res_lat/2,4)],
                    [round(lon-res_lon/2,4), round(lat-res_lat/2,4)]
                ]]},
                "properties": {
                    "sm_latest": round(sm_latest, 3) if sm_latest else None,
                    "sm_mean": round(sm_mean_val, 3),
                    "sm_max": round(sm_max_val, 3) if sm_max_val else None,
                    "sm_min": round(sm_min_val, 3) if sm_min_val else None,
                    "date": all_dates[-1],
                    "n_obs": n_obs,
                    **daily_props
                }
            })

    geojson = {"type": "FeatureCollection", "features": features}
    yield {"step": "smap", "status": f"Complete ({len(features)} cells, {len(all_dates)} days)", "pct": 50}
    yield (geojson, smap_daily)


def _build_ndvi(end_date):
    """Build NDVI GeoJSON. Yields progress events."""
    from fetch_ndvi import fetch_ndvi, merge_tiles_to_grid, ndvi_to_geojson
    from rasterio.transform import from_bounds
    import numpy as np

    yield {"step": "ndvi", "status": "Searching VIIRS composites...", "pct": 51}
    granules = fetch_ndvi(end_date, 1)
    if not granules:
        yield {"step": "ndvi", "status": "No NDVI data", "pct": 75}
        return

    yield {"step": "ndvi", "status": f"Processing {len(granules)} tiles...", "pct": 55}
    merged, date_str = merge_tiles_to_grid(granules)

    yield {"step": "ndvi", "status": "Polygonizing...", "pct": 70}
    output = os.path.join(PUBLIC, "lao_cai_ndvi.geojson")
    transform = from_bounds(103.45, 21.80, 104.75, 22.90, merged.shape[1], merged.shape[0])
    geojson = ndvi_to_geojson(merged, transform, merged.shape, date_str, output)

    yield {"step": "ndvi", "status": "Complete", "pct": 75}
    yield geojson


def _build_et(end_date):
    """Build ET GeoJSON. Yields progress events."""
    from fetch_et import fetch_et_granules, merge_et_tiles, et_to_geojson
    from rasterio.transform import from_bounds
    import numpy as np

    yield {"step": "et", "status": "Searching VIIRS ET...", "pct": 76}
    granules = fetch_et_granules(end_date, 1)
    if not granules:
        yield {"step": "et", "status": "No ET data", "pct": 100}
        return

    yield {"step": "et", "status": f"Processing {len(granules)} tiles...", "pct": 80}
    merged, date_str = merge_et_tiles(granules)

    yield {"step": "et", "status": "Polygonizing...", "pct": 95}
    output = os.path.join(PUBLIC, "lao_cai_et.geojson")
    transform = from_bounds(103.45, 21.80, 104.75, 22.90, merged.shape[1], merged.shape[0])
    geojson = et_to_geojson(merged, transform, merged.shape, date_str, output)

    yield {"step": "et", "status": "Complete", "pct": 100}
    yield geojson


def _build_fos_map(rainfall_gj, smap_gj, ndvi_gj, et_gj):
    """Compute Factor of Safety per slope unit. Yields progress events."""
    import numpy as np
    import math

    yield {"step": "fos", "status": "Loading slope units...", "pct": 0}

    su_path = os.path.join(PUBLIC, "lao_cai_slope_units.geojson")
    soil_path = os.path.join(PUBLIC, "lao_cai_soil_consolidated.geojson")

    if not os.path.exists(su_path):
        yield {"step": "fos", "status": "No slope units file", "pct": 0}
        return

    with open(su_path, "r") as f:
        slope_units = json.load(f)
    total = len(slope_units["features"])

    yield {"step": "fos", "status": f"Building spatial index ({total} units)...", "pct": 1}

    # --- Build lookup grids from GeoJSON features ---
    # Rainfall: regular 0.1° grid — index by (lat_bin, lon_bin)
    rain_grid = {}
    if rainfall_gj and "features" in rainfall_gj:
        for feat in rainfall_gj["features"]:
            c = feat["geometry"]["coordinates"][0]
            clat = round((c[0][1] + c[2][1]) / 2, 2)
            clon = round((c[0][0] + c[1][0]) / 2, 2)
            rain_grid[(clat, clon)] = feat["properties"]

    # SMAP: ~0.09° grid
    smap_grid = {}
    if smap_gj and "features" in smap_gj:
        for feat in smap_gj["features"]:
            c = feat["geometry"]["coordinates"][0]
            clat = round((c[0][1] + c[2][1]) / 2, 2)
            clon = round((c[0][0] + c[1][0]) / 2, 2)
            smap_grid[(clat, clon)] = feat["properties"]

    # NDVI: too many features for dict — build a simple grid (0.01° resolution lookup)
    ndvi_grid = {}
    if ndvi_gj and "features" in ndvi_gj:
        for feat in ndvi_gj["features"]:
            c = feat["geometry"]["coordinates"][0]
            clat = round((c[0][1] + c[2][1]) / 2, 2)
            clon = round((c[0][0] + c[1][0]) / 2, 2)
            ndvi_grid[(clat, clon)] = feat["properties"].get("ndvi")

    et_grid = {}
    if et_gj and "features" in et_gj:
        for feat in et_gj["features"]:
            c = feat["geometry"]["coordinates"][0]
            clat = round((c[0][1] + c[2][1]) / 2, 2)
            clon = round((c[0][0] + c[1][0]) / 2, 2)
            et_grid[(clat, clon)] = feat["properties"].get("et")

    # Soil: build centroid grid at 0.01° resolution
    soil_grid = {}
    if os.path.exists(soil_path):
        with open(soil_path, "r") as f:
            soil_gj = json.load(f)
        for feat in soil_gj["features"]:
            c = feat["geometry"]["coordinates"][0]
            clat = round((c[0][1] + c[2][1]) / 2, 2)
            clon = round((c[0][0] + c[1][0]) / 2, 2)
            soil_grid[(clat, clon)] = feat["properties"]

    yield {"step": "fos", "status": "Computing FoS per slope unit...", "pct": 3}

    def _nearest(grid, lat, lon, step=0.05):
        """Find nearest grid cell within ±step."""
        best = None
        best_dist = 999
        rlat = round(lat, 2)
        rlon = round(lon, 2)
        # Direct hit
        if (rlat, rlon) in grid:
            return grid[(rlat, rlon)]
        # Search neighborhood
        for dlat in np.arange(-step, step + 0.01, 0.01):
            for dlon in np.arange(-step, step + 0.01, 0.01):
                key = (round(rlat + dlat, 2), round(rlon + dlon, 2))
                if key in grid:
                    d = abs(dlat) + abs(dlon)
                    if d < best_dist:
                        best_dist = d
                        best = grid[key]
        return best

    def _nearest_coarse(grid, lat, lon, step=0.15):
        """Nearest for coarse grids (rainfall 0.1°, smap 0.09°)."""
        best = None
        best_dist = 999
        rlat = round(lat, 2)
        rlon = round(lon, 2)
        for dlat in np.arange(-step, step + 0.05, 0.05):
            for dlon in np.arange(-step, step + 0.05, 0.05):
                key = (round(rlat + dlat, 2), round(rlon + dlon, 2))
                if key in grid:
                    d = abs(dlat) + abs(dlon)
                    if d < best_dist:
                        best_dist = d
                        best = grid[key]
        return best

    # --- WRB lookup (same as frontend slopeStability.js) ---
    WRB_PARAMS = {
        0:  {"c": 8,  "phi": 26, "z": 1.5, "por": 0.42},
        2:  {"c": 6,  "phi": 24, "z": 1.8, "por": 0.45},
        3:  {"c": 8,  "phi": 26, "z": 1.5, "por": 0.42},
        6:  {"c": 10, "phi": 28, "z": 1.2, "por": 0.40},
        10: {"c": 12, "phi": 28, "z": 2.0, "por": 0.48},
        16: {"c": 4,  "phi": 20, "z": 1.0, "por": 0.50},
        18: {"c": 15, "phi": 32, "z": 0.5, "por": 0.35},
        20: {"c": 8,  "phi": 25, "z": 1.5, "por": 0.43},
        24: {"c": 7,  "phi": 24, "z": 1.8, "por": 0.44},
        29: {"c": 5,  "phi": 22, "z": 1.2, "por": 0.47},
    }
    DEG2RAD = math.pi / 180
    GAMMA_W = 9.81

    for idx, feat in enumerate(slope_units["features"]):
        if idx % 500 == 0:
            yield {"step": "fos", "status": f"Unit {idx+1}/{total}...", "pct": 3 + int((idx / total) * 95)}

        props = feat["properties"]
        slope_deg = props.get("mean_slope", 0)

        # Centroid of slope unit
        coords = feat["geometry"]["coordinates"][0]
        clat = sum(c[1] for c in coords) / len(coords)
        clon = sum(c[0] for c in coords) / len(coords)

        # --- Soil lookup ---
        soil = _nearest(soil_grid, clat, clon)
        if soil:
            wrb = soil.get("wrb_id", 0)
            clay = ((soil.get("clay_0_5") or 30) + (soil.get("clay_5_15") or 30)) / 2
            bulk = ((soil.get("bulk_0_5") or 1.1) + (soil.get("bulk_5_15") or 1.1)) / 2
        else:
            wrb, clay, bulk = 0, 30, 1.1

        base = WRB_PARAMS.get(wrb, WRB_PARAMS[0])
        clayD = (clay - 30) / 100
        c_prime = max(1, base["c"] + clayD * 10)
        phi_prime = max(15, base["phi"] - clayD * 8)
        gamma = bulk * 9.81
        z = base["z"]
        porosity = base["por"]

        # --- NDVI → root cohesion ---
        # Use NDVI value to infer vegetation density and root strength
        # NDVI > 0.6 → dense forest (c_root_max = 15 kPa)
        # NDVI 0.3-0.6 → scrub/grassland (c_root_max = 6 kPa)
        # NDVI 0.15-0.3 → cropland/sparse (c_root_max = 3 kPa)
        # NDVI < 0.15 → bare/rock (c_root_max = 0 kPa)
        ndvi_val = _nearest(ndvi_grid, clat, clon)
        ndvi_num = float(ndvi_val) if ndvi_val is not None else 0.3
        ndvi_clamped = max(0, min(1, ndvi_num))
        if ndvi_num > 0.6:
            c_root_max = 15
        elif ndvi_num > 0.3:
            c_root_max = 6
        elif ndvi_num > 0.15:
            c_root_max = 3
        else:
            c_root_max = 0
        c_root = ndvi_clamped * c_root_max

        # --- Saturation from SMAP + rainfall + ET ---
        smap_props = _nearest_coarse(smap_grid, clat, clon)
        sm = float(smap_props.get("sm_mean", 0)) if smap_props else 0.0

        rain_props = _nearest_coarse(rain_grid, clat, clon)
        r7 = float(rain_props.get("rain_7d", 0)) if rain_props else 0.0
        r15 = float(rain_props.get("rain_15d", 0)) if rain_props else 0.0

        et_val = _nearest(et_grid, clat, clon)
        et_num = float(et_val) if et_val is not None else 0.0

        # Saturation ratio
        m = min(sm / porosity, 1.0) if sm > 0 else 0.3
        m += ((r7 * 0.6 + r15 * 0.4) / 1000) / (z * porosity) * 0.3
        if et_num > 0:
            m -= (et_num / 1000) / (z * porosity)  # ET is mm/8-day, convert to volumetric fraction
        m = max(0, min(1, m))

        # --- Factor of Safety ---
        beta = max(slope_deg, 0.5) * DEG2RAD
        u = GAMMA_W * m * z * math.cos(beta) ** 2
        normal = gamma * z * math.cos(beta) ** 2
        resist = (c_prime + c_root) + max(0, normal - u) * math.tan(phi_prime * DEG2RAD)
        drive = gamma * z * math.sin(beta) * math.cos(beta)
        fos = min(resist / drive, 99.9) if drive > 0 else 99.9

        # --- Alerts ---
        alerts = []
        if r7 > 100 and fos < 1.2:
            alerts.append("rain_trigger")
        if r15 > 200 and clay > 30:
            alerts.append("saturated_clay")
        if sm > 0.35 and slope_deg > 25:
            alerts.append("wet_steep")

        # Add to properties
        props["fos"] = round(fos, 2)
        props["fos_m"] = round(m, 2)
        props["fos_cprime"] = round(c_prime, 1)
        props["fos_croot"] = round(c_root, 1)
        props["fos_phi"] = round(phi_prime, 1)
        props["fos_u"] = round(u, 1)
        props["rain_7d"] = round(r7, 1)
        props["sm_mean"] = round(sm, 3) if sm > 0 else None
        props["ndvi"] = round(ndvi_num, 2)
        props["wrb_id"] = wrb
        props["clay"] = round(clay, 0)
        props["alerts"] = ",".join(alerts) if alerts else ""

    yield {"step": "fos", "status": f"Complete ({total} units)", "pct": 98}
    yield slope_units


@app.get("/api/fetch-stream")
async def fetch_stream(
    end_date: str = Query(...),
    days: int = Query(30)
):
    """SSE endpoint - streams progress events then data events."""
    async def event_generator():
        import queue, threading

        async def stream_sync_gen(gen_func, *args):
            """Run a sync generator in a thread, yielding items back to async land."""
            q = queue.Queue()
            SENTINEL = object()

            def _run():
                try:
                    for item in gen_func(*args):
                        q.put(item)
                except Exception as e:
                    q.put({"step": "error", "status": str(e), "pct": 0})
                finally:
                    q.put(SENTINEL)

            t = threading.Thread(target=_run, daemon=True)
            t.start()
            while True:
                while q.empty():
                    await asyncio.sleep(0.05)
                item = q.get()
                if item is SENTINEL:
                    break
                yield item

        # --- Rainfall ---
        geojson = None
        daily_series = []
        async for item in stream_sync_gen(_build_rainfall, end_date, days):
            if isinstance(item, dict) and "step" in item:
                yield {"event": "progress", "data": json.dumps(item)}
            elif isinstance(item, tuple):
                geojson, daily_series = item

        if daily_series:
            yield {"event": "data", "data": json.dumps({"key": "rainfall", "daily_series": daily_series})}
        if geojson:
            # Save for FoS analysis
            with open(os.path.join(PUBLIC, "lao_cai_rainfall.geojson"), "w") as f:
                json.dump(geojson, f, separators=(",", ":"))
            yield {"event": "data", "data": json.dumps({"key": "rainfall", "geojson": geojson})}

        # --- SMAP ---
        smap_geojson = None
        smap_daily = []
        async for item in stream_sync_gen(_build_smap, end_date, days):
            if isinstance(item, dict) and "step" in item:
                yield {"event": "progress", "data": json.dumps(item)}
            elif isinstance(item, tuple):
                smap_geojson, smap_daily = item

        if smap_daily:
            yield {"event": "data", "data": json.dumps({"key": "smap", "smap_daily": smap_daily})}
        if smap_geojson:
            with open(os.path.join(PUBLIC, "lao_cai_smap.geojson"), "w") as f:
                json.dump(smap_geojson, f, separators=(",", ":"))
            yield {"event": "data", "data": json.dumps({"key": "smap", "geojson": smap_geojson})}

        # --- NDVI ---
        ndvi_geojson = None
        async for item in stream_sync_gen(_build_ndvi, end_date):
            if isinstance(item, dict) and "step" in item:
                yield {"event": "progress", "data": json.dumps(item)}
            else:
                ndvi_geojson = item

        if ndvi_geojson:
            yield {"event": "data", "data": json.dumps({"key": "ndvi", "geojson": ndvi_geojson})}

        # --- ET ---
        et_geojson = None
        async for item in stream_sync_gen(_build_et, end_date):
            if isinstance(item, dict) and "step" in item:
                yield {"event": "progress", "data": json.dumps(item)}
            else:
                et_geojson = item

        if et_geojson:
            yield {"event": "data", "data": json.dumps({"key": "et", "geojson": et_geojson})}

        yield {"event": "done", "data": json.dumps({"status": "complete"})}

    return EventSourceResponse(event_generator())


@app.get("/api/analyze-fos")
async def analyze_fos():
    """SSE endpoint — computes FoS per slope unit using latest fetched NASA data."""
    async def event_generator():
        import queue, threading

        # Load the latest NASA GeoJSON files from public/
        rainfall_gj = smap_gj = ndvi_gj = et_gj = None
        for name, var in [("lao_cai_rainfall.geojson", "rain"), ("lao_cai_smap.geojson", "smap"),
                          ("lao_cai_ndvi.geojson", "ndvi"), ("lao_cai_et.geojson", "et")]:
            path = os.path.join(PUBLIC, name)
            if os.path.exists(path) and os.path.getsize(path) > 100:
                with open(path, "r") as f:
                    gj = json.load(f)
                if var == "rain": rainfall_gj = gj
                elif var == "smap": smap_gj = gj
                elif var == "ndvi": ndvi_gj = gj
                elif var == "et": et_gj = gj

        q = queue.Queue()
        SENTINEL = object()

        def _run():
            try:
                for item in _build_fos_map(rainfall_gj, smap_gj, ndvi_gj, et_gj):
                    q.put(item)
            except Exception as e:
                q.put({"step": "error", "status": str(e), "pct": 0})
            finally:
                q.put(SENTINEL)

        t = threading.Thread(target=_run, daemon=True)
        t.start()
        while True:
            while q.empty():
                await asyncio.sleep(0.05)
            item = q.get()
            if item is SENTINEL:
                break
            if isinstance(item, dict) and "step" in item:
                yield {"event": "progress", "data": json.dumps(item)}
            else:
                # Save the analyzed slope units back to public folder for persistence
                with open(os.path.join(PUBLIC, "lao_cai_slope_units.geojson"), "w") as f:
                    json.dump(item, f, separators=(",", ":"))
                yield {"event": "data", "data": json.dumps({"key": "slope-units", "geojson": item})}

        yield {"event": "done", "data": json.dumps({"status": "complete"})}

    return EventSourceResponse(event_generator())


# Keep old endpoints for backward compat
@app.get("/api/rainfall")
def get_rainfall(end_date: str = Query(...), days: int = Query(30)):
    gen = _build_rainfall(end_date, days)
    geojson = daily_series = None
    for item in gen:
        if isinstance(item, tuple):
            geojson, daily_series = item
    if not geojson:
        return JSONResponse({"error": "No data"}, status_code=404)
    return {"geojson": geojson, "daily_series": daily_series}


@app.get("/api/smap")
def get_smap(end_date: str = Query(...), days: int = Query(30)):
    gen = _build_smap(end_date, days)
    geojson = None
    for item in gen:
        if not isinstance(item, dict) or "step" not in item:
            geojson = item
    if not geojson:
        return JSONResponse({"error": "No data"}, status_code=404)
    return {"geojson": geojson}


@app.get("/api/ndvi")
def get_ndvi(end_date: str = Query(...)):
    gen = _build_ndvi(end_date)
    geojson = None
    for item in gen:
        if not isinstance(item, dict) or "step" not in item:
            geojson = item
    if not geojson:
        return JSONResponse({"error": "No data"}, status_code=404)
    return {"geojson": geojson}


@app.get("/api/et")
def get_et(end_date: str = Query(...)):
    gen = _build_et(end_date)
    geojson = None
    for item in gen:
        if not isinstance(item, dict) or "step" not in item:
            geojson = item
    if not geojson:
        return JSONResponse({"error": "No data"}, status_code=404)
    return {"geojson": geojson}


CACHE_ROOTS = {
    "rainfall": ("C:/Users/024792/Downloads/landslide/rainfall_cache", "imerg"),
    "smap":     ("C:/Users/024792/Downloads/landslide/smap_cache",     "smap"),
    "ndvi":     ("C:/Users/024792/Downloads/landslide/ndvi_cache",     "ndvi"),
    "et":       ("C:/Users/024792/Downloads/landslide/et_cache",       "et"),
}


def _scan_cache(cache_dir, prefix):
    """Scan a cache dir and group files by date (handles per-tile files like ndvi_YYYYMMDD_hXXvYY.h5)."""
    if not os.path.exists(cache_dir):
        return []
    date_sizes = {}
    for fp in glob.glob(os.path.join(cache_dir, f"{prefix}_*")):
        fname = os.path.basename(fp)
        date = fname[len(prefix) + 1: len(prefix) + 9]   # chars right after "prefix_"
        if len(date) == 8 and date.isdigit():
            sz = os.path.getsize(fp)
            if sz > 0:
                date_sizes[date] = date_sizes.get(date, 0) + sz
    return sorted(
        [{"date": d, "size": sz} for d, sz in date_sizes.items()],
        key=lambda x: x["date"],
        reverse=True,
    )


@app.get("/api/cache-status")
def get_cache_status():
    """Return all cached files grouped by type with sizes."""
    return {key: _scan_cache(cache_dir, prefix) for key, (cache_dir, prefix) in CACHE_ROOTS.items()}


@app.get("/api/data-ready")
def data_ready():
    """Whether the NASA layer geojsons are already on disk — used by the UI to
    restore `dataLoaded` after a page refresh or a partial SSE failure."""
    required = [
        "lao_cai_rainfall.geojson",
        "lao_cai_smap.geojson",
        "lao_cai_ndvi.geojson",
        "lao_cai_et.geojson",
    ]
    files = {name: (os.path.exists(os.path.join(PUBLIC, name))
                    and os.path.getsize(os.path.join(PUBLIC, name)) > 100)
             for name in required}
    return {"ready": all(files.values()), "files": files}


@app.delete("/api/cache-delete")
async def delete_cache_files(request: Request):
    """Delete cache files for given dates. Body: {type: str, dates: [str]}"""
    body = await request.json()
    cache_type = body.get("type")
    dates = body.get("dates", [])

    if cache_type not in CACHE_ROOTS:
        return JSONResponse({"error": "Unknown type"}, status_code=400)

    cache_dir, prefix = CACHE_ROOTS[cache_type]
    deleted, errors = [], []
    for date in dates:
        # Match all tile files for this date (e.g. ndvi_20260322_h27v06.h5, ndvi_20260322.hdf)
        for fp in glob.glob(os.path.join(cache_dir, f"{prefix}_{date}*")):
            try:
                os.remove(fp)
                deleted.append(os.path.basename(fp))
            except Exception as e:
                errors.append({"file": os.path.basename(fp), "error": str(e)})

    return {"deleted": deleted, "errors": errors}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
