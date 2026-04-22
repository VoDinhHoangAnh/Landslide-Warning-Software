"""
Fetch VIIRS Evapotranspiration (VNP16A2) data for Lao Cai.
HDF5 format, 500m resolution, 8-day composite.
"""

import numpy as np
import json
import os
import h5py
from urllib.request import Request, urlopen
from datetime import datetime, timedelta
from dotenv import load_dotenv
from pyproj import Transformer
from rasterio.transform import from_bounds
from rasterio.features import shapes
from shapely.geometry import shape as shp, mapping

load_dotenv("C:/Users/024792/Downloads/landslide/.env")
TOKEN = os.getenv("NASA_EARTHDATA_TOKEN")

BBOX = (103.45, 21.80, 104.75, 22.90)
CACHE_DIR = "C:/Users/024792/Downloads/landslide/et_cache"
os.makedirs(CACHE_DIR, exist_ok=True)


def fetch_et_granules(end_date_str, n_composites=1):
    end_date = datetime.strptime(end_date_str, "%Y%m%d")
    start_date = end_date - timedelta(days=n_composites * 8 + 16)

    print(f"ET: Searching {start_date.date()} to {end_date.date()}...")

    url = (
        f"https://cmr.earthdata.nasa.gov/search/granules.json"
        f"?short_name=VNP16A2&version=002"
        f"&temporal={start_date.strftime('%Y-%m-%dT00:00:00Z')},{end_date.strftime('%Y-%m-%dT23:59:59Z')}"
        f"&bounding_box={BBOX[0]},{BBOX[1] - 2},{BBOX[2]},{BBOX[3]}"
        f"&page_size=20&sort_key=-start_date"
    )
    req = Request(url)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        resp = urlopen(req)
        data = json.loads(resp.read())
    except Exception as e:
        print(f"  CMR request failed: {e}")
        return []

    from collections import defaultdict
    date_tiles = defaultdict(list)
    for entry in data.get("feed", {}).get("entry", []):
        title = entry["title"]
        parts = title.split(".")
        doy = parts[1]
        tile = parts[2]
        year = int(doy[1:5])
        day_of_year = int(doy[5:])
        date = datetime(year, 1, 1) + timedelta(days=day_of_year - 1)
        date_str = date.strftime("%Y%m%d")

        for link in entry.get("links", []):
            href = link.get("href", "")
            if href.endswith(".h5") and "data." in href:
                date_tiles[date_str].append({"date": date_str, "tile": tile, "url": href})
                break

    sorted_dates = sorted(date_tiles.keys(), reverse=True)[:n_composites]
    granules = []
    for d in sorted_dates:
        granules.extend(date_tiles[d])

    print(f"  Found {len(granules)} ET tiles across {len(sorted_dates)} composites")
    return granules


def download_and_extract_et(granule):
    tile = granule.get('tile', 'unknown')
    cache_path = os.path.join(CACHE_DIR, f"et_{granule['date']}_{tile}.h5")

    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        print(f"  {granule['date']} (cached)")
    else:
        print(f"  Downloading ET {granule['date']}...")
        tmp_path = cache_path + ".tmp"
        req = Request(granule["url"])
        req.add_header("Authorization", f"Bearer {TOKEN}")
        resp = urlopen(req)
        with open(tmp_path, "wb") as f:
            f.write(resp.read())
        if os.path.getsize(tmp_path) > 0:
            os.replace(tmp_path, cache_path)
        else:
            os.remove(tmp_path)
            raise RuntimeError(f"Downloaded empty file for ET {granule['date']}")

    with h5py.File(cache_path, "r") as f:
        # Find the grid
        grids = f["HDFEOS"]["GRIDS"]
        grid_name = list(grids.keys())[0]
        grid = grids[grid_name]

        # Find ET dataset
        data_fields = grid["Data Fields"]
        # List available fields to find ET
        et_key = None
        for key in data_fields.keys():
            if "ET" in key.upper() and "PET" not in key.upper() and "LE" not in key.upper():
                et_key = key
                break
        if et_key is None:
            # Fallback: use first field with ET
            for key in data_fields.keys():
                if "ET" in key:
                    et_key = key
                    break

        print(f"  Using field: {et_key}")
        et_raw = data_fields[et_key][:]

        xdim = grid["XDim"][:]
        ydim = grid["YDim"][:]

    # ET scale: 0.1 mm/8day, fill values >= 32761
    et = et_raw.astype(np.float32) * 0.1
    et[(et_raw >= 32761) | (et < 0)] = np.nan

    bounds = (float(xdim[0]), float(ydim[0]), float(xdim[-1]), float(ydim[-1]))
    return et, bounds, granule["date"]


def et_to_geojson(grid, transform, shape, date_str, output_path):
    """Convert pre-built ET grid to GeoJSON."""
    from rasterio.features import shapes
    from shapely.geometry import shape as shp, mapping

    bin_size = 3.0
    et_binned = np.where(np.isnan(grid), -9999, np.floor(grid / bin_size) * bin_size).astype(np.float32)
    valid_mask = (~np.isnan(grid)).astype(np.uint8)

    features = []
    for geom, value in shapes(et_binned, mask=valid_mask, transform=transform):
        if value <= -9999:
            continue
        poly = shp(geom)
        poly = poly.simplify(0.0005, preserve_topology=True)
        if poly.is_empty or not poly.is_valid:
            continue

        features.append({
            "type": "Feature",
            "geometry": mapping(poly),
            "properties": {
                "et": round(float(value) + bin_size / 2, 1),
                "date": date_str
            }
        })

    geojson = {"type": "FeatureCollection", "features": features}
    with open(output_path, "w") as f:
        json.dump(geojson, f, separators=(",", ":"))

    size_kb = os.path.getsize(output_path) / 1024
    print(f"  ET GeoJSON: {len(features)} polygons, {size_kb:.1f} KB")
    return geojson


def merge_et_tiles(granules):
    """Download multiple tiles and merge into single grid."""
    out_res = 0.005
    out_lons = np.arange(BBOX[0], BBOX[2], out_res)
    out_lats = np.arange(BBOX[1], BBOX[3], out_res)
    merged = np.full((len(out_lats), len(out_lons)), np.nan, dtype=np.float32)

    inv_transformer = Transformer.from_crs(
        "EPSG:4326",
        "+proj=sinu +R=6371007.181 +nadgrids=@null +wktext",
        always_xy=True
    )

    date_str = granules[0]["date"]

    for g in granules:
        et_data, (ul_x, ul_y, lr_x, lr_y), _ = download_and_extract_et(g)
        nrow, ncol = et_data.shape
        pixel_w = (lr_x - ul_x) / ncol
        pixel_h = (ul_y - lr_y) / nrow

        for i, lat in enumerate(out_lats):
            for j, lon in enumerate(out_lons):
                if not np.isnan(merged[i, j]):
                    continue
                sx, sy = inv_transformer.transform(lon, lat)
                col = int((sx - ul_x) / pixel_w)
                row = int((ul_y - sy) / pixel_h)
                if 0 <= row < nrow and 0 <= col < ncol:
                    val = et_data[row, col]
                    if not np.isnan(val):
                        merged[i, j] = val

    merged = merged[::-1]
    print(f"  Merged ET grid: valid {(~np.isnan(merged)).sum()} / {merged.size}")
    return merged, date_str


if __name__ == "__main__":
    OUTPUT = "C:/Users/024792/Downloads/landslide/public/lao_cai_et.geojson"
    granules = fetch_et_granules("20260412", 1)
    if granules:
        merged, date_str = merge_et_tiles(granules)
        print(f"  ET range: {np.nanmin(merged):.1f} to {np.nanmax(merged):.1f} mm/8day")

        from rasterio.transform import from_bounds
        transform = from_bounds(BBOX[0], BBOX[1], BBOX[2], BBOX[3], merged.shape[1], merged.shape[0])
        et_to_geojson(merged, transform, merged.shape, date_str, OUTPUT)
    print("Done!")
