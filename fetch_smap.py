"""
Fetch NASA SMAP L3 Enhanced Soil Moisture data for Lao Cai.
Output: GeoJSON grid with soil moisture (m³/m³) per cell.
"""

import numpy as np
import json
import os
import h5py
from urllib.request import Request, urlopen
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv("C:/Users/024792/Downloads/landslide/.env")
TOKEN = os.getenv("NASA_EARTHDATA_TOKEN")

BBOX = (103.45, 21.80, 104.75, 22.90)
CACHE_DIR = "C:/Users/024792/Downloads/landslide/smap_cache"
os.makedirs(CACHE_DIR, exist_ok=True)


def find_smap_granules(start, end):
    """Search NASA CMR for SMAP L3 Enhanced granules."""
    url = (
        f"https://cmr.earthdata.nasa.gov/search/granules.json"
        f"?short_name=SPL3SMP_E&version=006"
        f"&temporal={start.strftime('%Y-%m-%dT00:00:00Z')},{end.strftime('%Y-%m-%dT23:59:59Z')}"
        f"&bounding_box={BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]}"
        f"&page_size=200&sort_key=start_date"
    )
    req = Request(url)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        resp = urlopen(req, timeout=30)
        data = json.loads(resp.read())
    except Exception as e:
        print(f"  SMAP CMR request failed: {e}")
        return []

    feed = data.get("feed")
    if not feed or "entry" not in feed:
        return []

    granules = []
    for entry in feed["entry"]:
        try:
            title = entry["title"]
            parts = title.split("_")
            date_str = parts[5]
            for link in entry.get("links", []):
                href = link.get("href", "")
                if href.endswith(".h5") and "data." in href:
                    granules.append({"date": date_str, "url": href})
                    break
        except (KeyError, IndexError):
            continue
    return granules


HARMONY_COLLECTION_ID = "C2938664763-NSIDC_CPRD"  # SPL3SMP_E v006


def _build_harmony_url(date_str):
    """Build NASA Harmony subset URL for a single SMAP date over Lao Cai bbox (~1.4MB instead of 600MB)."""
    d = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    return (
        f"https://harmony.earthdata.nasa.gov/{HARMONY_COLLECTION_ID}"
        f"/ogc-api-coverages/1.0.0/collections/all/coverage/rangeset"
        f"?subset=lat({BBOX[1]}:{BBOX[3]})&subset=lon({BBOX[0]}:{BBOX[2]})"
        f"&subset=time(%22{d}T00:00:00Z%22:%22{d}T23:59:59Z%22)"
        f"&maxResults=1&forceAsync=false&skipPreview=true"
    )


def download_smap_granule(granule):
    """Download SMAP — uses Harmony spatial subset (~1.4MB) with full-file fallback."""
    date_str = granule["date"]
    cache_path = os.path.join(CACHE_DIR, f"smap_{date_str}.h5")

    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path

    tmp_path = cache_path + ".tmp"

    # Try Harmony subset first (1.4MB instead of 600MB)
    try:
        harmony_url = _build_harmony_url(date_str)
        print(f"  Subset SMAP {date_str} (~1.4MB)...")
        req = Request(harmony_url)
        req.add_header("Authorization", f"Bearer {TOKEN}")
        resp = urlopen(req, timeout=90)
        with open(tmp_path, "wb") as f:
            f.write(resp.read())
        if os.path.getsize(tmp_path) > 0:
            os.replace(tmp_path, cache_path)
            return cache_path
    except Exception as e:
        print(f"  Harmony failed for {date_str}: {e}, falling back to full download...")
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    # No fallback to 600MB full download — skip this granule
    raise RuntimeError(f"Harmony subset failed for {date_str}, skipping (full file is 600MB)")


def extract_smap(h5_path):
    """Extract soil moisture data for Lao Cai bbox from a SMAP h5 file."""
    with h5py.File(h5_path, "r") as hf:
        group = hf["Soil_Moisture_Retrieval_Data_AM"]
        sm = group["soil_moisture"][:]
        lat = group["latitude"][:]
        lon = group["longitude"][:]

    # Replace fill values with NaN
    sm = np.where(sm < 0, np.nan, sm)
    lat_clean = np.where(lat < -9000, np.nan, lat)
    lon_clean = np.where(lon < -9000, np.nan, lon)

    # For Harmony-subsetted files (small arrays), use full array — already bbox-cropped
    # For legacy full files (large arrays), crop to bbox
    if sm.shape[0] > 50:
        mask = (lon >= BBOX[0]) & (lon <= BBOX[2]) & (lat >= BBOX[1]) & (lat <= BBOX[3])
        if not mask.any():
            return None, None, None
        rows, cols = np.where(mask)
        r_min, r_max = rows.min(), rows.max() + 1
        c_min, c_max = cols.min(), cols.max() + 1
        return sm[r_min:r_max, c_min:c_max], lat_clean[r_min:r_max, c_min:c_max], lon_clean[r_min:r_max, c_min:c_max]

    # Harmony subset: already cropped, just check for any valid data
    if np.all(np.isnan(sm)):
        return None, None, None

    return sm, lat_clean, lon_clean


def smap_to_geojson(all_sm, lats, lons, output_path):
    """Convert SMAP data to GeoJSON grid."""
    if not all_sm or lats is None:
        print("  No SMAP data available")
        return None

    sorted_dates = sorted(all_sm.keys())
    latest = all_sm[sorted_dates[-1]]

    stack = np.stack([all_sm[d] for d in sorted_dates], axis=0)
    mean_sm = np.nanmean(stack, axis=0)
    max_sm = np.nanmax(stack, axis=0)
    min_sm = np.nanmin(stack, axis=0)

    features = []
    res = 0.09

    for i in range(lats.shape[0]):
        for j in range(lats.shape[1]):
            lat = float(lats[i, j])
            lon = float(lons[i, j])
            sm_latest = float(latest[i, j]) if not np.isnan(latest[i, j]) else None
            sm_mean = float(mean_sm[i, j]) if not np.isnan(mean_sm[i, j]) else None
            sm_max_val = float(max_sm[i, j]) if not np.isnan(max_sm[i, j]) else None

            if sm_mean is None:
                continue

            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[
                        [round(lon - res/2, 4), round(lat - res/2, 4)],
                        [round(lon + res/2, 4), round(lat - res/2, 4)],
                        [round(lon + res/2, 4), round(lat + res/2, 4)],
                        [round(lon - res/2, 4), round(lat + res/2, 4)],
                        [round(lon - res/2, 4), round(lat - res/2, 4)]
                    ]]
                },
                "properties": {
                    "sm_latest": round(sm_latest, 3) if sm_latest else None,
                    "sm_mean": round(sm_mean, 3),
                    "sm_max": round(sm_max_val, 3) if sm_max_val else None,
                    "sm_min": round(float(min_sm[i, j]), 3) if not np.isnan(min_sm[i, j]) else None,
                    "date": sorted_dates[-1],
                    "n_obs": int(np.sum(~np.isnan(stack[:, i, j])))
                }
            })

    geojson = {"type": "FeatureCollection", "features": features}
    if output_path:
        with open(output_path, "w") as f:
            json.dump(geojson, f, separators=(",", ":"))
        print(f"  SMAP GeoJSON: {len(features)} cells, {os.path.getsize(output_path)/1024:.1f} KB")
    return geojson


if __name__ == "__main__":
    OUTPUT = "C:/Users/024792/Downloads/landslide/public/lao_cai_smap.geojson"
    end_dt = datetime(2026, 4, 12)
    start_dt = end_dt - timedelta(days=29)
    granules = find_smap_granules(start_dt, end_dt)
    print(f"Found {len(granules)} SMAP granules")

    all_sm = {}
    lats = lons = None
    for g in granules:
        path = download_smap_granule(g)
        sm, la, lo = extract_smap(path)
        if sm is not None:
            all_sm[g["date"]] = sm
            if lats is None:
                lats, lons = la, lo

    smap_to_geojson(all_sm, lats, lons, OUTPUT)
    print("Done!")
