"""
Fetch VIIRS NDVI (VNP13A1) data for Lao Cai.
HDF5 format, 500m resolution, 8-day composite.
"""

import numpy as np
import json
import os
import h5py
from urllib.request import Request, urlopen
from datetime import datetime, timedelta
from dotenv import load_dotenv
import rasterio
from rasterio.transform import from_bounds
from rasterio.features import shapes
from shapely.geometry import shape as shp, mapping

load_dotenv("C:/Users/024792/Downloads/landslide/.env")
TOKEN = os.getenv("NASA_EARTHDATA_TOKEN")

BBOX = (103.45, 21.80, 104.75, 22.90)
CACHE_DIR = "C:/Users/024792/Downloads/landslide/ndvi_cache"
os.makedirs(CACHE_DIR, exist_ok=True)


def fetch_ndvi(end_date_str, n_composites=1):
    end_date = datetime.strptime(end_date_str, "%Y%m%d")
    start_date = end_date - timedelta(days=n_composites * 8 + 16)

    print(f"NDVI: Searching {start_date.date()} to {end_date.date()}...")

    url = (
        f"https://cmr.earthdata.nasa.gov/search/granules.json"
        f"?short_name=VNP13A1&version=002"
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

    # Group by date, collect all tiles per date
    from collections import defaultdict
    date_tiles = defaultdict(list)
    for entry in data.get("feed", {}).get("entry", []):
        title = entry["title"]
        parts = title.split(".")
        doy = parts[1]
        tile = parts[2]  # h27v06 or h27v07
        year = int(doy[1:5])
        day_of_year = int(doy[5:])
        date = datetime(year, 1, 1) + timedelta(days=day_of_year - 1)
        date_str = date.strftime("%Y%m%d")

        for link in entry.get("links", []):
            href = link.get("href", "")
            if href.endswith(".h5") and "data." in href:
                date_tiles[date_str].append({"date": date_str, "tile": tile, "url": href})
                break

    # Return all tiles for the latest n composites
    sorted_dates = sorted(date_tiles.keys(), reverse=True)[:n_composites]
    granules = []
    for d in sorted_dates:
        granules.extend(date_tiles[d])

    print(f"  Found {len(granules)} NDVI tiles across {len(sorted_dates)} composites")
    return granules


def download_and_extract_ndvi(granule):
    tile = granule.get('tile', 'unknown')
    cache_path = os.path.join(CACHE_DIR, f"ndvi_{granule['date']}_{tile}.h5")

    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        print(f"  {granule['date']} (cached)")
    else:
        print(f"  Downloading NDVI {granule['date']}...")
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
            raise RuntimeError(f"Downloaded empty file for NDVI {granule['date']}")

    # Read VIIRS NDVI from HDF5
    # VIIRS uses sinusoidal grid, tile h27v06
    with h5py.File(cache_path, "r") as f:
        # Navigate HDF5 structure
        grid = f["HDFEOS"]["GRIDS"]["VIIRS_Grid_16Day_VI_500m"]
        ndvi_raw = grid["Data Fields"]["500 m 16 days NDVI"][:]

        # Get sinusoidal coordinates from XDim/YDim
        xdim = grid["XDim"][:]
        ydim = grid["YDim"][:]
        ul_lon = float(xdim[0])
        lr_lon = float(xdim[-1])
        ul_lat = float(ydim[0])
        lr_lat = float(ydim[-1])

    # NDVI scale factor
    ndvi = ndvi_raw.astype(np.float32) * 0.0001
    ndvi[(ndvi < -0.2) | (ndvi > 1.0)] = np.nan

    return ndvi, (ul_lon, ul_lat, lr_lon, lr_lat), granule["date"]


def ndvi_to_geojson(grid, transform, shape, date_str, output_path):
    """Convert pre-built NDVI grid (already in WGS84, top-down) to GeoJSON."""
    bin_size = 0.05
    ndvi_binned = np.where(np.isnan(grid), -9999, np.floor(grid / bin_size) * bin_size).astype(np.float32)
    valid_mask = (~np.isnan(grid)).astype(np.uint8)

    features = []
    for geom, value in shapes(ndvi_binned, mask=valid_mask, transform=transform):
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
                "ndvi": round(float(value) + bin_size / 2, 3),
                "date": date_str
            }
        })

    geojson = {"type": "FeatureCollection", "features": features}
    with open(output_path, "w") as f:
        json.dump(geojson, f, separators=(",", ":"))

    size_kb = os.path.getsize(output_path) / 1024
    print(f"  NDVI GeoJSON: {len(features)} polygons, {size_kb:.1f} KB")
    return geojson


def merge_tiles_to_grid(granules):
    """Download multiple tiles and merge into a single output grid covering BBOX."""
    from pyproj import Transformer
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
        ndvi, (ul_x, ul_y, lr_x, lr_y), _ = download_and_extract_ndvi(g)
        nrow, ncol = ndvi.shape
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
                    val = ndvi[row, col]
                    if not np.isnan(val):
                        merged[i, j] = val

    # Flip for from_bounds (row 0 = north)
    merged = merged[::-1]
    print(f"  Merged grid: {merged.shape}, valid: {(~np.isnan(merged)).sum()} / {merged.size}")
    return merged, date_str


if __name__ == "__main__":
    OUTPUT = "C:/Users/024792/Downloads/landslide/public/lao_cai_ndvi.geojson"
    granules = fetch_ndvi("20260412", 1)
    if granules:
        merged, date_str = merge_tiles_to_grid(granules)
        print(f"  NDVI range: {np.nanmin(merged):.3f} to {np.nanmax(merged):.3f}")

        from rasterio.transform import from_bounds
        transform = from_bounds(BBOX[0], BBOX[1], BBOX[2], BBOX[3], merged.shape[1], merged.shape[0])
        ndvi_to_geojson(merged, transform, merged.shape, date_str, OUTPUT)
    print("Done!")
