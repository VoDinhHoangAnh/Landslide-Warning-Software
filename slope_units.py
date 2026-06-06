"""
Generate slope units for Lao Cai using watershed-based terrain segmentation.
Slope units = intersection of catchments (from DEM) and inverse-catchments (from inverted DEM).
Each unit represents one natural slope facet between a ridge line and a valley line.
"""

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.features import shapes
from scipy import ndimage
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
import json
import gzip
import shutil
import os
from urllib.request import urlopen
from io import BytesIO

# Lao Cai bbox
BBOX = (103.45, 21.80, 104.75, 22.90)
OUTPUT = "C:/Users/024792/Downloads/landslide/lao_cai_slope_units.geojson"
PUBLIC = "C:/Users/024792/Downloads/landslide/public/lao_cai_slope_units.geojson"
DEM_DIR = "C:/Users/024792/Downloads/landslide/dem_cache"

os.makedirs(DEM_DIR, exist_ok=True)

# ============================================================
# Step 1: Download SRTM 1-arcsec DEM tiles
# ============================================================
def download_srtm_tile(lat, lon):
    """Download a single SRTM .hgt tile from AWS."""
    ns = 'N' if lat >= 0 else 'S'
    ew = 'E' if lon >= 0 else 'W'
    name = f"{ns}{abs(lat):02d}{ew}{abs(lon):03d}"
    hgt_path = os.path.join(DEM_DIR, f"{name}.hgt")

    if os.path.exists(hgt_path):
        print(f"  {name}.hgt (cached)")
        return hgt_path

    url = f"https://elevation-tiles-prod.s3.amazonaws.com/skadi/{ns}{abs(lat):02d}/{name}.hgt.gz"
    print(f"  Downloading {name}.hgt.gz ...")
    response = urlopen(url)
    compressed = BytesIO(response.read())
    with gzip.open(compressed) as gz:
        with open(hgt_path, 'wb') as f:
            f.write(gz.read())
    return hgt_path

print("Step 1: Downloading SRTM DEM tiles...")
# Tiles needed for bbox
lat_min, lat_max = int(np.floor(BBOX[1])), int(np.floor(BBOX[3]))
lon_min, lon_max = int(np.floor(BBOX[0])), int(np.floor(BBOX[2]))

tiles = []
for lat in range(lat_min, lat_max + 1):
    for lon in range(lon_min, lon_max + 1):
        tiles.append(download_srtm_tile(lat, lon))

# ============================================================
# Step 2: Merge tiles and crop to bbox
# ============================================================
print("Step 2: Merging and cropping DEM...")

def read_hgt(path):
    """Read SRTM .hgt file (3601x3601 for 1-arcsec)."""
    data = np.fromfile(path, dtype='>i2')  # big-endian signed 16-bit
    size = int(np.sqrt(data.size))
    return data.reshape(size, size)

# Parse tile coordinates from filename
tile_data = {}
for path in tiles:
    name = os.path.basename(path).replace('.hgt', '')
    lat = int(name[1:3]) * (1 if name[0] == 'N' else -1)
    lon = int(name[4:7]) * (1 if name[3] == 'E' else -1)
    tile_data[(lat, lon)] = read_hgt(path)

# Determine full mosaic dimensions
lats = sorted(set(k[0] for k in tile_data.keys()), reverse=True)
lons = sorted(set(k[1] for k in tile_data.keys()))
tile_size = list(tile_data.values())[0].shape[0]

# Assemble mosaic
rows = []
for lat in lats:
    row = []
    for lon in lons:
        if (lat, lon) in tile_data:
            row.append(tile_data[(lat, lon)])
        else:
            row.append(np.zeros((tile_size, tile_size), dtype=np.int16))
    rows.append(np.concatenate(row, axis=1))
mosaic = np.concatenate(rows, axis=0).astype(np.float32)

# Mosaic georeference
mosaic_top = max(lats) + 1
mosaic_left = min(lons)
mosaic_bottom = min(lats)
mosaic_right = max(lons) + 1
res = 1.0 / (tile_size - 1)

# Crop to bbox
col_start = int((BBOX[0] - mosaic_left) / res)
col_end = int((BBOX[2] - mosaic_left) / res)
row_start = int((mosaic_top - BBOX[3]) / res)
row_end = int((mosaic_top - BBOX[1]) / res)

dem = mosaic[row_start:row_end, col_start:col_end]
dem_transform = from_bounds(BBOX[0], BBOX[1], BBOX[2], BBOX[3], dem.shape[1], dem.shape[0])

# Handle voids
dem[dem < -100] = 0
dem[dem > 9000] = 0

print(f"DEM shape: {dem.shape}, range: {dem[dem>0].min():.0f} - {dem.max():.0f} m")

# ============================================================
# Step 3: Fill depressions and compute flow
# ============================================================
print("Step 3: Computing flow direction and accumulation...")

def fill_depressions(dem, max_iter=100):
    """Simple depression filling using iterative conditional dilation."""
    filled = dem.copy()
    for _ in range(max_iter):
        # For each cell, if it's lower than all neighbors and not on the edge,
        # raise it to the minimum neighbor elevation
        padded = np.pad(filled, 1, mode='edge')
        neighbors = np.stack([
            padded[0:-2, 0:-2], padded[0:-2, 1:-1], padded[0:-2, 2:],
            padded[1:-1, 0:-2],                       padded[1:-1, 2:],
            padded[2:,   0:-2], padded[2:,   1:-1], padded[2:,   2:]
        ])
        min_neighbor = neighbors.min(axis=0)
        pits = (filled < min_neighbor) & (filled > 0)
        if not pits.any():
            break
        filled[pits] = min_neighbor[pits]
    return filled

def compute_flow_direction_d8(dem):
    """D8 flow direction. Returns direction as 0-7 (8 neighbors)."""
    # Offsets: 0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW
    dy = [-1, -1,  0,  1, 1,  1,  0, -1]
    dx = [ 0,  1,  1,  1, 0, -1, -1, -1]
    dist = [1, 1.414, 1, 1.414, 1, 1.414, 1, 1.414]

    h, w = dem.shape
    fdir = np.full((h, w), -1, dtype=np.int8)

    padded = np.pad(dem, 1, mode='constant', constant_values=9999)

    max_drop = np.zeros((h, w), dtype=np.float32)

    for i in range(8):
        neighbor = padded[1+dy[i]:h+1+dy[i], 1+dx[i]:w+1+dx[i]]
        drop = (dem - neighbor) / dist[i]
        steeper = drop > max_drop
        fdir[steeper] = i
        max_drop[steeper] = drop[steeper]

    return fdir

def compute_flow_accumulation(fdir):
    """Compute flow accumulation from D8 flow direction."""
    dy = [-1, -1,  0,  1, 1,  1,  0, -1]
    dx = [ 0,  1,  1,  1, 0, -1, -1, -1]

    h, w = fdir.shape
    acc = np.ones((h, w), dtype=np.int32)

    # Count incoming flows for topological sort
    in_degree = np.zeros((h, w), dtype=np.int32)
    for r in range(h):
        for c in range(w):
            d = fdir[r, c]
            if d >= 0:
                nr, nc = r + dy[d], c + dx[d]
                if 0 <= nr < h and 0 <= nc < w:
                    in_degree[nr, nc] += 1

    # BFS from sources (cells with no inflow)
    from collections import deque
    queue = deque()
    for r in range(h):
        for c in range(w):
            if in_degree[r, c] == 0:
                queue.append((r, c))

    while queue:
        r, c = queue.popleft()
        d = fdir[r, c]
        if d >= 0:
            nr, nc = r + dy[d], c + dx[d]
            if 0 <= nr < h and 0 <= nc < w:
                acc[nr, nc] += acc[r, c]
                in_degree[nr, nc] -= 1
                if in_degree[nr, nc] == 0:
                    queue.append((nr, nc))

    return acc

filled_dem = fill_depressions(dem)
print("  Depressions filled")

fdir = compute_flow_direction_d8(filled_dem)
print("  Flow direction computed")

print("  Computing flow accumulation (this takes a moment)...")
acc = compute_flow_accumulation(fdir)
print(f"  Flow accumulation: max={acc.max()}")

# ============================================================
# Step 4: Delineate sub-watersheds
# ============================================================
print("Step 4: Delineating catchments...")

# Pour points = cells where accumulation exceeds threshold
# Threshold controls the size of slope units
# Higher threshold = larger units, fewer polygons
ACC_THRESHOLD = 500  # higher = larger slope units, fewer polygons. Lowered from 2000 to subdivide plateau mega-polygons.

pour_points = acc >= ACC_THRESHOLD

# Label connected stream segments and find local maxima as pour points
# Use watershed segmentation from the pour points
from scipy.ndimage import label, watershed_ift

# Create catchment labels using watershed on inverted accumulation
# Seeds = stream network (pour points)
seeds = np.zeros_like(acc, dtype=np.int32)
stream_mask = acc >= ACC_THRESHOLD

# Label each stream segment
stream_labels, n_streams = label(stream_mask)
print(f"  Stream segments: {n_streams}")

# Watershed from stream labels on the DEM surface
# Use negative DEM so watershed flows "downhill" to streams
# Normalize DEM to uint16 range for watershed_ift
dem_norm = filled_dem - filled_dem.min()
dem_uint16 = ((dem_norm / dem_norm.max()) * 65534).astype(np.uint16)
# Invert so watershed grows from low elevation (streams)
catchments = watershed_ift(65534 - dem_uint16, stream_labels)
n_catchments = catchments.max()
print(f"  Catchments from DEM: {n_catchments}")

# ============================================================
# Step 5: Inverted DEM catchments (ridge-based)
# ============================================================
print("Step 5: Computing inverse catchments (ridge lines)...")

inv_dem = filled_dem.max() - filled_dem
inv_dem[dem <= 0] = 0
inv_filled = fill_depressions(inv_dem)
inv_fdir = compute_flow_direction_d8(inv_filled)
print("  Inverse flow accumulation...")
inv_acc = compute_flow_accumulation(inv_fdir)

inv_stream = inv_acc >= ACC_THRESHOLD
inv_labels, n_inv = label(inv_stream)
inv_norm = inv_filled - inv_filled.min()
inv_uint16 = ((inv_norm / inv_norm.max()) * 65534).astype(np.uint16)
inv_catchments = watershed_ift(65534 - inv_uint16, inv_labels)
print(f"  Ridge catchments: {inv_catchments.max()}")

# ============================================================
# Step 6: Intersect to create slope units
# ============================================================
print("Step 6: Intersecting catchments to create slope units...")

# Composite label = catchment_id * max_inv + inv_catchment_id
max_inv = inv_catchments.max() + 1
slope_unit_grid = catchments.astype(np.int32) * max_inv + inv_catchments.astype(np.int32)

# Zero out nodata
slope_unit_grid[dem <= 0] = 0

unique_units = len(np.unique(slope_unit_grid[slope_unit_grid > 0]))
print(f"  Raw slope units: {unique_units}")

# ============================================================
# Step 7: Compute stats per slope unit and polygonize
# ============================================================
print("Step 7: Computing terrain stats and polygonizing...")

# Pre-compute slope in degrees
# Pixel spacing in meters (~30m for 1-arcsec SRTM)
res_deg = (BBOX[2] - BBOX[0]) / dem.shape[1]
dy_m = res_deg * 111320  # meters per pixel in Y
dx_m = res_deg * 111320 * np.cos(np.radians(22.35))  # meters per pixel in X

# Slope = arctan(rise/run) where rise = dz, run = pixel spacing in meters
dz_dy = np.gradient(filled_dem, dy_m, axis=0)
dz_dx = np.gradient(filled_dem, dx_m, axis=1)
slope_deg = np.degrees(np.arctan(np.sqrt(dz_dy**2 + dz_dx**2)))

valid_mask = (slope_unit_grid > 0).astype(np.uint8)
features = []

for geom, value in shapes(slope_unit_grid, mask=valid_mask, transform=dem_transform):
    value = int(value)
    if value == 0:
        continue

    poly = shape(geom)
    if poly.is_empty or not poly.is_valid:
        continue

    # Skip very tiny polygons
    if poly.area < 5e-6:  # ~0.05 km²
        continue

    # Get pixel mask for this unit
    unit_mask = slope_unit_grid == value

    if unit_mask.sum() == 0:
        continue

    # Compute stats
    elev_vals = filled_dem[unit_mask]
    slope_vals = slope_deg[unit_mask]
    acc_vals = acc[unit_mask]

    mean_elev = float(np.mean(elev_vals))
    mean_slope = float(np.mean(slope_vals))
    max_slope = float(np.max(slope_vals))
    area_km2 = float(poly.area * 111.32 * 111.32 * np.cos(np.radians(22.35)))
    elev_range = float(np.max(elev_vals) - np.min(elev_vals))
    mean_acc = float(np.mean(acc_vals))

    # Simplify geometry slightly for output size
    poly = poly.simplify(0.0005, preserve_topology=True)

    features.append({
        "type": "Feature",
        "geometry": mapping(poly),
        "properties": {
            "mean_elev": round(mean_elev, 1),
            "mean_slope": round(mean_slope, 1),
            "max_slope": round(max_slope, 1),
            "elev_range": round(elev_range, 1),
            "area_km2": round(area_km2, 3),
            "flow_acc": round(mean_acc, 0)
        }
    })

print(f"Generated {len(features)} slope units")

# ============================================================
# Step 8: Write GeoJSON
# ============================================================
print("Step 8: Writing GeoJSON...")

geojson = {"type": "FeatureCollection", "features": features}
with open(OUTPUT, 'w') as f:
    json.dump(geojson, f, separators=(',', ':'))

size_mb = os.path.getsize(OUTPUT) / (1024 * 1024)
print(f"Size: {size_mb:.2f} MB, {len(features)} slope units")

shutil.copy2(OUTPUT, PUBLIC)
print(f"Copied to {PUBLIC}")
print("Done!")
