"""
Fetch NASA GPM IMERG Daily Late Run precipitation data for Lao Cai.
Computes antecedent rainfall metrics for landslide early warning.
"""

import numpy as np
import json
import os
import shutil
from urllib.request import Request, urlopen
from datetime import datetime, timedelta
from dotenv import load_dotenv
import netCDF4

load_dotenv("C:/Users/024792/Downloads/landslide/.env")
TOKEN = os.getenv("NASA_EARTHDATA_TOKEN")

BBOX = (103.45, 21.80, 104.75, 22.90)
CACHE_DIR = "C:/Users/024792/Downloads/landslide/rainfall_cache"
os.makedirs(CACHE_DIR, exist_ok=True)


def find_granule_urls(start, end):
    """Search NASA CMR for GPM IMERG Daily Late Run granules."""
    url = (
        f"https://cmr.earthdata.nasa.gov/search/granules.json"
        f"?short_name=GPM_3IMERGDL&version=07"
        f"&temporal={start.strftime('%Y-%m-%dT00:00:00Z')},{end.strftime('%Y-%m-%dT23:59:59Z')}"
        f"&bounding_box={BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]}"
        f"&page_size=100&sort_key=start_date"
    )
    req = Request(url)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        resp = urlopen(req)
        data = json.loads(resp.read())
    except Exception as e:
        print(f"  CMR request failed: {e}")
        return []

    feed = data.get("feed")
    if not feed or "entry" not in feed:
        print(f"  Unexpected CMR response format: {list(data.keys())}")
        return []

    granules = []
    for entry in feed["entry"]:
        try:
            title = entry["title"]
            date_str = title.split(".")[5].split("-")[0]
            for link in entry.get("links", []):
                href = link.get("href", "")
                if href.endswith(".nc4") and "data.gesdisc" in href:
                    granules.append({"date": date_str, "url": href})
                    break
        except (KeyError, IndexError):
            continue
    return granules


def _build_opendap_url(download_url):
    """Transform a GES DISC download URL into an OPeNDAP subset URL for Lao Cai bbox."""
    import math
    opendap_base = download_url.replace(
        "data.gesdisc.earthdata.nasa.gov/data/",
        "gpm1.gesdisc.eosdis.nasa.gov/opendap/"
    )
    # IMERG 0.1° grid: lon=-179.95..179.95 (3600), lat=-89.95..89.95 (1800)
    lon_s = math.floor((BBOX[0] + 179.95) / 0.1)
    lon_e = math.ceil((BBOX[2] + 179.95) / 0.1)
    lat_s = math.floor((BBOX[1] + 89.95) / 0.1)
    lat_e = math.ceil((BBOX[3] + 89.95) / 0.1)
    return f"{opendap_base}.nc4?precipitation[0:0][{lon_s}:{lon_e}][{lat_s}:{lat_e}],lon[{lon_s}:{lon_e}],lat[{lat_s}:{lat_e}]"


def download_granule(granule):
    """Download a GPM IMERG file — uses OPeNDAP spatial subset (~30KB) with full-file fallback."""
    date_str = granule["date"]
    cache_path = os.path.join(CACHE_DIR, f"imerg_{date_str}.nc4")

    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path

    tmp_path = cache_path + ".tmp"

    # Try OPeNDAP subset first (30KB instead of 28MB)
    try:
        subset_url = _build_opendap_url(granule["url"])
        print(f"  Subset {date_str} (~30KB)...")
        req = Request(subset_url)
        req.add_header("Authorization", f"Bearer {TOKEN}")
        resp = urlopen(req, timeout=30)
        with open(tmp_path, "wb") as f:
            f.write(resp.read())
        if os.path.getsize(tmp_path) > 0:
            os.replace(tmp_path, cache_path)
            return cache_path
    except Exception as e:
        print(f"  OPeNDAP failed for {date_str}: {e}, falling back to full download...")
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    # Fallback: full file download
    print(f"  Downloading full {date_str} (~28MB)...")
    req = Request(granule["url"])
    req.add_header("Authorization", f"Bearer {TOKEN}")
    resp = urlopen(req)
    with open(tmp_path, "wb") as f:
        f.write(resp.read())

    if os.path.getsize(tmp_path) > 0:
        os.replace(tmp_path, cache_path)
    else:
        os.remove(tmp_path)
        raise RuntimeError(f"Downloaded empty file for {date_str}")

    return cache_path


def extract_precip(nc4_path):
    """Extract daily precipitation (mm/day) for Lao Cai bbox from IMERG nc4."""
    ds = netCDF4.Dataset(nc4_path, "r")

    lon = ds.variables["lon"][:]
    lat = ds.variables["lat"][:]

    lon_mask = (lon >= BBOX[0]) & (lon <= BBOX[2])
    lat_mask = (lat >= BBOX[1]) & (lat <= BBOX[3])
    lon_idx = np.where(lon_mask)[0]
    lat_idx = np.where(lat_mask)[0]

    precip_var = ds.variables["precipitation"]
    precip = precip_var[:]

    if precip.ndim == 3:
        precip = precip[0]

    precip_crop = precip[lon_idx[0]:lon_idx[-1]+1, lat_idx[0]:lat_idx[-1]+1]
    precip_crop = precip_crop.T

    lons = lon[lon_idx]
    lats = lat[lat_idx]

    ds.close()

    precip_crop = np.ma.filled(precip_crop, 0)
    precip_crop[precip_crop < 0] = 0

    return precip_crop, lats, lons


if __name__ == "__main__":
    OUTPUT = "C:/Users/024792/Downloads/landslide/lao_cai_rainfall.geojson"
    PUBLIC = "C:/Users/024792/Downloads/landslide/public/lao_cai_rainfall.geojson"

    end_date = datetime(2026, 4, 12)
    start_date = end_date - timedelta(days=29)

    print("Finding granules...")
    granules = find_granule_urls(start_date, end_date)
    print(f"Found {len(granules)} granules")

    nc4_files = {}
    for g in granules:
        path = download_granule(g)
        nc4_files[g["date"]] = path

    all_precip = {}
    lats = lons = None
    sorted_dates = sorted(nc4_files.keys())
    for d in sorted_dates:
        precip, lats, lons = extract_precip(nc4_files[d])
        all_precip[d] = precip

    precip_stack = np.stack([all_precip[d] for d in sorted_dates], axis=0)
    rain_today = all_precip[sorted_dates[-1]]
    rain_3d = precip_stack[-3:].sum(axis=0)
    rain_7d = precip_stack[-7:].sum(axis=0)
    rain_15d = precip_stack[-15:].sum(axis=0)
    rain_30d = precip_stack.sum(axis=0)
    rain_max = precip_stack.max(axis=0)
    rain_mean = precip_stack.mean(axis=0)
    wet_days = (precip_stack > 1.0).sum(axis=0)

    res = 0.1
    features = []
    for i, lat in enumerate(lats):
        for j, lon in enumerate(lons):
            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[
                        [round(float(lon) - res/2, 3), round(float(lat) - res/2, 3)],
                        [round(float(lon) + res/2, 3), round(float(lat) - res/2, 3)],
                        [round(float(lon) + res/2, 3), round(float(lat) + res/2, 3)],
                        [round(float(lon) - res/2, 3), round(float(lat) + res/2, 3)],
                        [round(float(lon) - res/2, 3), round(float(lat) - res/2, 3)]
                    ]]
                },
                "properties": {
                    "rain_today": round(float(rain_today[i, j]), 1),
                    "rain_3d": round(float(rain_3d[i, j]), 1),
                    "rain_7d": round(float(rain_7d[i, j]), 1),
                    "rain_15d": round(float(rain_15d[i, j]), 1),
                    "rain_30d": round(float(rain_30d[i, j]), 1),
                    "rain_max": round(float(rain_max[i, j]), 1),
                    "rain_mean": round(float(rain_mean[i, j]), 2),
                    "wet_days": int(wet_days[i, j]),
                    "date": sorted_dates[-1]
                }
            })

    geojson = {"type": "FeatureCollection", "features": features}
    with open(OUTPUT, "w") as f:
        json.dump(geojson, f, separators=(",", ":"))
    shutil.copy2(OUTPUT, PUBLIC)
    print(f"Done! {len(features)} cells, {os.path.getsize(OUTPUT)/1024:.1f} KB")
