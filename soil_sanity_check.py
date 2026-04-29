"""
Sanity check: how much variation do WRB group + clay + bulk density create
in the FOS formula across Lao Cai pixels?
Samples random valid pixels, computes c', phi', gamma, and FOS at fixed slopes.
"""
import numpy as np
import rasterio
import math

BASE = "C:/Users/024792/Downloads/landslide/LaoCai_Lithological_Parameters/"

WRB_PARAMS = {
    0:  {"name": "Unknown",    "c": 8,  "phi": 26, "z": 1.5, "por": 0.42},
    2:  {"name": "Alisol",     "c": 6,  "phi": 24, "z": 1.8, "por": 0.45},
    3:  {"name": "Acrisol",    "c": 8,  "phi": 26, "z": 1.5, "por": 0.42},
    6:  {"name": "Cambisol",   "c": 10, "phi": 28, "z": 1.2, "por": 0.40},
    10: {"name": "Ferralsol",  "c": 12, "phi": 28, "z": 2.0, "por": 0.48},
    16: {"name": "Gleysol",    "c": 4,  "phi": 20, "z": 1.0, "por": 0.50},
    18: {"name": "Leptosol",   "c": 15, "phi": 32, "z": 0.5, "por": 0.35},
    20: {"name": "Luvisol",    "c": 8,  "phi": 25, "z": 1.5, "por": 0.43},
    24: {"name": "Plinthosol", "c": 7,  "phi": 24, "z": 1.8, "por": 0.44},
    29: {"name": "Stagnosol",  "c": 5,  "phi": 22, "z": 1.2, "por": 0.47},
}
GAMMA_W = 9.81
DEG2RAD = math.pi / 180
C_ROOT_MODERATE = 2.0   # fixed moderate root cohesion (kPa)
M_WET = 0.45            # moderate saturation

def load(name):
    with rasterio.open(BASE + name) as ds:
        return ds.read(1).astype(np.float32), ds.transform, ds.shape

clay05, trans, shape = load("clay 0-5.tif")
clay15, _, _ = load("clay 5-15.tif")
bulk05, _, _ = load("bulk density 0-5.tif")
bulk15, _, _ = load("bulk density 5-15.tif")

with rasterio.open(BASE + "soil groups.tif") as ds:
    from rasterio.enums import Resampling
    wrb = ds.read(1, out_shape=shape, resampling=Resampling.nearest).astype(np.int16)

# unit conversion
clay05 = clay05 / 10.0
clay15 = clay15 / 10.0
bulk05 = bulk05 / 100.0
bulk15 = bulk15 / 100.0

valid = (clay05 > 0) & (bulk05 > 0) & (wrb > 0)
print(f"Valid pixels: {valid.sum():,}")

# ===== WRB distribution =====
print("\n=== WRB group distribution across Lào Cai ===")
unique_wrb, counts = np.unique(wrb[valid], return_counts=True)
total_valid = counts.sum()
for w, c in sorted(zip(unique_wrb, counts), key=lambda x: -x[1]):
    name = WRB_PARAMS.get(int(w), {"name": "unmapped"})["name"]
    pct = c / total_valid * 100
    print(f"  WRB {int(w):2d} [{name:10s}]: {c:7,} px  ({pct:5.1f}%)")

# ===== Clay + bulk range =====
print(f"\n=== Clay content range ===")
print(f"  clay 0-5:  min {clay05[valid].min():.1f}%  mean {clay05[valid].mean():.1f}%  max {clay05[valid].max():.1f}%")
print(f"  clay 5-15: min {clay15[valid].min():.1f}%  mean {clay15[valid].mean():.1f}%  max {clay15[valid].max():.1f}%")
print(f"\n=== Bulk density range ===")
print(f"  bulk 0-5:  min {bulk05[valid].min():.2f}  mean {bulk05[valid].mean():.2f}  max {bulk05[valid].max():.2f} g/cm³")
print(f"  bulk 5-15: min {bulk15[valid].min():.2f}  mean {bulk15[valid].mean():.2f}  max {bulk15[valid].max():.2f} g/cm³")

# ===== Sample 15 random valid pixels =====
rng = np.random.default_rng(42)
valid_idx = np.argwhere(valid)
sample_idx = valid_idx[rng.choice(len(valid_idx), size=15, replace=False)]

def compute(w, clay, bulk):
    base = WRB_PARAMS.get(int(w), WRB_PARAMS[0])
    clayD = (clay - 30) / 100
    c_prime = max(1, base["c"] + clayD * 10)
    phi_prime = max(15, base["phi"] - clayD * 8)
    gamma = bulk * 9.81
    return c_prime, phi_prime, gamma, base["z"], base["por"], base["name"]

def fos(slope_deg, c_prime, phi_prime, gamma, z, c_root=C_ROOT_MODERATE, m=M_WET):
    beta = max(slope_deg, 0.5) * DEG2RAD
    u = GAMMA_W * m * z * math.cos(beta) ** 2
    normal = gamma * z * math.cos(beta) ** 2
    resist = (c_prime + c_root) + max(0, normal - u) * math.tan(phi_prime * DEG2RAD)
    drive = gamma * z * math.sin(beta) * math.cos(beta)
    return min(resist / drive, 99.9) if drive > 0 else 99.9

print("\n=== Soil variation across 15 random pixels ===")
print("(m=0.45, c_root=2.0, FOS at 3 slopes to see soil-only effect)")
print(f"{'#':>2} {'WRB':10s} {'clay':>6} {'bulk':>6} | {'c_prime':>8} {'phi':>6} {'gamma':>7} {'z':>4} | {'FOS@15°':>8} {'FOS@30°':>8} {'FOS@45°':>8}")
print("-" * 115)

results = []
for i, (r, cc) in enumerate(sample_idx):
    c05 = float(clay05[r, cc]); c15 = float(clay15[r, cc])
    b05 = float(bulk05[r, cc]); b15 = float(bulk15[r, cc])
    w = int(wrb[r, cc])
    clay = (c05 + c15) / 2
    bulk = (b05 + b15) / 2
    c_p, phi_p, gamma, z, por, name = compute(w, clay, bulk)
    f15 = fos(15, c_p, phi_p, gamma, z)
    f30 = fos(30, c_p, phi_p, gamma, z)
    f45 = fos(45, c_p, phi_p, gamma, z)
    results.append((f15, f30, f45))
    print(f"{i+1:2d} {name[:10]:10s} {clay:5.1f}% {bulk:5.2f} | {c_p:7.2f} {phi_p:5.1f}° {gamma:6.2f} {z:4.1f} | {f15:7.2f} {f30:7.2f} {f45:7.2f}")

# Variation stats
arr = np.array(results)
print(f"\n=== How much does soil alone swing FOS? ===")
for i, slope in enumerate([15, 30, 45]):
    col = arr[:, i]
    print(f"  Slope {slope}°: FOS min {col.min():.2f}  max {col.max():.2f}  spread {(col.max()-col.min()):.2f}  cv {col.std()/col.mean()*100:.1f}%")

# Worst vs best stable configuration
print(f"\n=== Soil-only hypothesis test (slope=30°, m=0.45) ===")
print("Running all 10 WRB groups at their mean clay+bulk:")
for wid, p in WRB_PARAMS.items():
    c_p, phi_p, gamma, z, por, name = compute(wid, 30.0, 1.3)  # neutral clay, avg bulk
    f30 = fos(30, c_p, phi_p, gamma, z)
    print(f"  WRB {wid:2d} [{name:10s}]: c'={c_p:5.2f}  phi={phi_p:.1f}°  z={z}  => FOS@30° = {f30:.2f}")
