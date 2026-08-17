#!/usr/bin/env python3
"""
Builds a geographically accurate California relief heightfield and emits it as a
TypeScript preset module for /home/boab/physics.

Sources
  boundary : glynnbird/usstatesgeojson california.geojson (US Census derived)
  elevation: AWS "terrarium" terrain tiles (Mapzen/Amazon open terrain tiles),
             zoom 7 -> ~1 km/px at California's latitude
Projection
  EPSG:3310 "California Albers" -- Albers Equal Area Conic, GRS80 ellipsoid,
  standard parallels 34 N and 40.5 N, central meridian 120 W, latitude of
  origin 0 N. This is the state's own official projection, so the plan view of
  the carving is the shape California is legally drawn as.
"""

import base64, io, json, math, os, sys, urllib.request
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
os.makedirs(CACHE, exist_ok=True)

# --- output geometry --------------------------------------------------------
# Sized for a 50 x 40 x 40 mm block: the map runs north-south along the 40 mm
# axis with a couple of millimetres of margin, which leaves the state about
# 30 mm wide on the 50 mm axis.
STOCK_W_MM, STOCK_D_MM, STOCK_T_MM = 50.0, 40.0, 40.0
MAP_HEIGHT_MM = 35.0           # north-south, inside the 40 mm axis
ROWS = 108                     # ~0.32 mm per grid row
PLINTH_FRACTION = 0.10         # share of total model height below the lowest land

# How deep the carving goes, top face to the floor of the background.
#
# This is the design decision the whole preset hangs off, so it is stated here
# rather than left to fall out of something else. 20 mm on a 35 mm map is a
# deliberately dramatic carving: the Sierra crest stands at the stock's top face
# and the ocean floor is 20 mm down, which works out to well over a hundred
# times true vertical scale. That is a sculpture of California rather than a map
# of it, and it is what this preset is for. The exaggeration figure below is
# computed and reported, not chosen.
RELIEF_DEPTH_MM = 20.0

# ---------------------------------------------------------------------------
# Albers Equal Area Conic, ellipsoidal (Snyder, Map Projections -- A Working
# Manual, pp. 101-102). GRS80.
# ---------------------------------------------------------------------------
A = 6378137.0
F = 1 / 298.257222101
E2 = F * (2 - F)
E = math.sqrt(E2)

PHI0 = math.radians(0.0)
LAM0 = math.radians(-120.0)
PHI1 = math.radians(34.0)
PHI2 = math.radians(40.5)
FALSE_NORTHING = -4000000.0


def _q(phi):
    s = np.sin(phi)
    return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * np.log((1 - E * s) / (1 + E * s)))


def _m(phi):
    s = np.sin(phi)
    return np.cos(phi) / np.sqrt(1 - E2 * s * s)


_m1, _m2 = _m(PHI1), _m(PHI2)
_q0, _q1, _q2 = _q(PHI0), _q(PHI1), _q(PHI2)
N = (_m1**2 - _m2**2) / (_q2 - _q1)
C = _m1**2 + N * _q1
RHO0 = A * math.sqrt(C - N * _q0) / N


def albers_fwd(lon_deg, lat_deg):
    """lon/lat in degrees -> EPSG:3310 easting/northing in metres."""
    phi = np.radians(lat_deg)
    lam = np.radians(lon_deg)
    rho = A * np.sqrt(C - N * _q(phi)) / N
    theta = N * (lam - LAM0)
    return rho * np.sin(theta), RHO0 - rho * np.cos(theta) + FALSE_NORTHING


def albers_inv(x, y):
    """EPSG:3310 easting/northing in metres -> lon/lat in degrees."""
    yy = y - FALSE_NORTHING
    rho = np.sqrt(x**2 + (RHO0 - yy) ** 2)
    theta = np.arctan2(x, RHO0 - yy)
    q = (C - (rho * N / A) ** 2) / N
    # Snyder 3-16: iterate phi from the authalic latitude.
    phi = np.arcsin(np.clip(q / 2, -1, 1))
    for _ in range(12):
        s = np.sin(phi)
        one = 1 - E2 * s * s
        dphi = (one**2 / (2 * np.cos(phi))) * (
            q / (1 - E2) - s / one + (1 / (2 * E)) * np.log((1 - E * s) / (1 + E * s))
        )
        phi = phi + dphi
    lam = LAM0 + theta / N
    return np.degrees(lam), np.degrees(phi)


# ---------------------------------------------------------------------------
# Boundary
# ---------------------------------------------------------------------------
BOUNDARY_URL = (
    "https://raw.githubusercontent.com/glynnbird/usstatesgeojson/master/california.geojson"
)


def load_rings():
    path = os.path.join(CACHE, "california.geojson")
    if not os.path.exists(path):
        with urllib.request.urlopen(BOUNDARY_URL, timeout=60) as r:
            data = r.read()
        with open(path, "wb") as fh:
            fh.write(data)
    with open(path) as fh:
        geom = json.load(fh)["geometry"]
    if geom["type"] == "Polygon":
        polys = [geom["coordinates"]]
    else:
        polys = geom["coordinates"]
    # Outer ring of every polygon; California has no holes.
    return [np.asarray(p[0], dtype=np.float64) for p in polys]


def point_in_rings(px, py, rings_xy):
    """Even-odd ray cast of many points against many closed rings, vectorised."""
    inside = np.zeros(px.shape, dtype=bool)
    for ring in rings_xy:
        x, y = ring[:, 0], ring[:, 1]
        x1, y1 = np.roll(x, -1), np.roll(y, -1)
        for i in range(len(x)):
            ax, ay, bx, by = x[i], y[i], x1[i], y1[i]
            if ay == by:
                continue
            straddles = (ay > py) != (by > py)
            if not straddles.any():
                continue
            t = (py - ay) / (by - ay)
            crossing = straddles & (px < ax + t * (bx - ax))
            inside ^= crossing
    return inside


def depinch(mask):
    """
    Fills corner-only connections, so the mask is edge-connected everywhere.

    Where two land cells meet at nothing but a corner -- a river mouth pinching
    shut, a headland one cell wide -- the solid built from the mask has a vertex
    four walls run through, which is not a manifold and which a mesh repairer
    downstream would have to guess at. Filling the corner adds one 0.56 mm cell
    of land, well under what a 3 mm ball nose resolves, and makes the shape
    unambiguous. Runs to a fixpoint because a fill can create a fresh pinch.
    """
    filled = 0
    while True:
        a = mask[:-1, :-1] & mask[1:, 1:] & ~mask[:-1, 1:] & ~mask[1:, :-1]
        b = mask[:-1, 1:] & mask[1:, :-1] & ~mask[:-1, :-1] & ~mask[1:, 1:]
        if not (a.any() or b.any()):
            return filled
        # Always fill the same corner of the pair, so the result is reproducible.
        mask[:-1, 1:] |= a
        mask[:-1, :-1] |= b
        filled += int(a.sum() + b.sum())


# ---------------------------------------------------------------------------
# Elevation -- terrarium tiles
# ---------------------------------------------------------------------------
TILE_Z = 7
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def lonlat_to_tilexy(lon, lat, z):
    n = 2**z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def fetch_tile(z, x, y):
    path = os.path.join(CACHE, f"{z}_{x}_{y}.png")
    if not os.path.exists(path):
        url = TILE_URL.format(z=z, x=x, y=y)
        with urllib.request.urlopen(url, timeout=60) as r:
            data = r.read()
        with open(path, "wb") as fh:
            fh.write(data)
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)


def build_dem(lon_min, lon_max, lat_min, lat_max, z=TILE_Z):
    """Mosaic of terrarium tiles covering the bbox, plus its pixel-space origin."""
    x0f, y1f = lonlat_to_tilexy(lon_min, lat_min, z)
    x1f, y0f = lonlat_to_tilexy(lon_max, lat_max, z)
    tx0, tx1 = int(math.floor(x0f)), int(math.floor(x1f))
    ty0, ty1 = int(math.floor(y0f)), int(math.floor(y1f))
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    print(f"  terrarium z{z}: {nx}x{ny} = {nx*ny} tiles", file=sys.stderr)

    mosaic = np.zeros((ny * 256, nx * 256), dtype=np.float32)
    for j, ty in enumerate(range(ty0, ty1 + 1)):
        for i, tx in enumerate(range(tx0, tx1 + 1)):
            rgb = fetch_tile(z, tx, ty)
            # terrarium: elevation = (R * 256 + G + B / 256) - 32768
            elev = rgb[:, :, 0] * 256.0 + rgb[:, :, 1] + rgb[:, :, 2] / 256.0 - 32768.0
            mosaic[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256] = elev
    return mosaic, tx0 * 256, ty0 * 256


def sample_dem(mosaic, ox, oy, lon, lat, z=TILE_Z):
    """Bilinear sample of the mosaic at lon/lat arrays."""
    n = 2**z
    px = (lon + 180.0) / 360.0 * n * 256.0 - ox
    lat_r = np.radians(np.clip(lat, -85.0, 85.0))
    py = (1.0 - np.log(np.tan(lat_r) + 1 / np.cos(lat_r)) / np.pi) / 2.0 * n * 256.0 - oy

    h, w = mosaic.shape
    px = np.clip(px, 0, w - 1.001)
    py = np.clip(py, 0, h - 1.001)
    x0, y0 = np.floor(px).astype(int), np.floor(py).astype(int)
    fx, fy = px - x0, py - y0
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    top = mosaic[y0, x0] * (1 - fx) + mosaic[y0, x1] * fx
    bot = mosaic[y1, x0] * (1 - fx) + mosaic[y1, x1] * fx
    return top * (1 - fy) + bot * fy


# ---------------------------------------------------------------------------
def main():
    rings_ll = load_rings()
    print(f"boundary: {len(rings_ll)} rings, {sum(len(r) for r in rings_ll)} points", file=sys.stderr)

    # Project every boundary vertex; the projected bbox is what sets the aspect.
    rings_xy = []
    for r in rings_ll:
        ex, ny_ = albers_fwd(r[:, 0], r[:, 1])
        rings_xy.append(np.column_stack([ex, ny_]))
    allxy = np.vstack(rings_xy)
    xmin, xmax = allxy[:, 0].min(), allxy[:, 0].max()
    ymin, ymax = allxy[:, 1].min(), allxy[:, 1].max()
    proj_w, proj_h = xmax - xmin, ymax - ymin
    aspect = proj_w / proj_h
    map_w_mm = MAP_HEIGHT_MM * aspect
    cols = max(2, int(round(ROWS * aspect)))
    print(f"projected bbox: {proj_w/1000:.1f} km E-W x {proj_h/1000:.1f} km N-S", file=sys.stderr)
    print(f"aspect {aspect:.5f} -> {map_w_mm:.3f} mm wide x {MAP_HEIGHT_MM} mm tall", file=sys.stderr)
    print(f"grid {cols} x {ROWS}  ({map_w_mm/cols:.3f} x {MAP_HEIGHT_MM/ROWS:.3f} mm per cell)", file=sys.stderr)

    # Cell-centre sample points in projected space.
    cx = xmin + (np.arange(cols) + 0.5) * proj_w / cols
    cy = ymin + (np.arange(ROWS) + 0.5) * proj_h / ROWS
    gx, gy = np.meshgrid(cx, cy)
    glon, glat = albers_inv(gx, gy)

    lon_pad, lat_pad = 0.35, 0.35
    mosaic, ox, oy = build_dem(
        float(glon.min()) - lon_pad, float(glon.max()) + lon_pad,
        float(glat.min()) - lat_pad, float(glat.max()) + lat_pad,
    )
    elev = sample_dem(mosaic, ox, oy, glon, glat).astype(np.float64)

    mask = point_in_rings(gx, gy, rings_xy)
    print(f"land cells: {mask.sum()} of {mask.size} ({100*mask.sum()/mask.size:.1f}%)", file=sys.stderr)
    pinches = depinch(mask)
    print(f"depinched {pinches} diagonal touch points", file=sys.stderr)

    land = elev[mask]
    print(f"elevation on land: {land.min():.0f} m to {land.max():.0f} m", file=sys.stderr)

    # Ocean pixels bleeding in at the coastline would cut a trench just inside
    # the shore; the coast is sea level, not the shelf below it.
    elev = np.maximum(elev, -86.0)
    lo, hi = float(elev[mask].min()), float(elev[mask].max())

    # Quantise to 8 bits. Over a ~8.5 mm terrain range that is a 33 um step --
    # two orders of magnitude below what a 3 mm ball nose resolves.
    q = np.zeros(elev.shape, dtype=np.uint8)
    q[mask] = np.round((elev[mask] - lo) / (hi - lo) * 255.0).astype(np.uint8)
    payload = base64.b64encode(np.packbits(mask).tobytes() + q.tobytes()).decode()

    write_ts(cols, ROWS, map_w_mm, lo, hi, aspect, payload,
             proj_w, proj_h, int(mask.sum()), pinches)


TS_PATH = os.path.join(HERE, "..", "src", "presets", "californiaRelief.ts")


def write_ts(cols, rows, map_w_mm, lo, hi, aspect, payload, proj_w, proj_h, land_cells, pinches):
    km_per_mm = (proj_h / 1000) / MAP_HEIGHT_MM
    # What the terrain's own relief would measure if Z were carved at plan scale.
    true_mm = ((hi - lo) / 1000) / km_per_mm
    # Depth is the design input; the exaggeration is whatever that comes to.
    carve_depth_mm = RELIEF_DEPTH_MM
    carved_mm = carve_depth_mm * (1 - PLINTH_FRACTION)
    exagg = carved_mm / true_mm
    # Where sea level lands, which is what the coastline is cut down to. Badwater
    # is below it, so the coast does not sit right on the floor of the land.
    coast_mm = -carve_depth_mm + PLINTH_FRACTION * carve_depth_mm + (-lo / (hi - lo)) * carved_mm
    src = f'''// ---------------------------------------------------------------------------
// California, as a relief-carvable heightfield
// ---------------------------------------------------------------------------
//
// A geographically accurate terrain model of the state, sized for a {MAP_HEIGHT_MM:.0f} mm tall
// carving in a {STOCK_W_MM:.0f} x {STOCK_D_MM:.0f} x {STOCK_T_MM:.0f} mm block. It exists to be fed to the relief carve
// exporter, so it is built the way that exporter wants its input: a closed solid
// whose plan view is the state's real outline and whose top surface is the real
// terrain.
//
// PROJECTION
//   EPSG:3310, "California Albers" -- Albers Equal Area Conic on GRS80, standard
//   parallels 34 N and 40.5 N, central meridian 120 W. That is the state's own
//   official projection, which is what makes the outline the shape California is
//   actually drawn as rather than the stretched one a plate carree gives you.
//   Equal-area also means a square centimetre of carving is the same number of
//   square kilometres wherever it falls on the block.
//
// SOURCES
//   Outline   -- US Census state boundary, rasterised to {land_cells} land cells.
//                {pinches} corner-only connection{'' if pinches == 1 else 's'} filled so the mask is edge
//                connected and the solid built from it is a manifold; each costs
//                one {MAP_HEIGHT_MM/rows:.2f} mm cell, well below what the finishing tool resolves.
//   Elevation -- AWS open terrain tiles (terrarium encoding) at zoom 7, roughly
//                1 km per pixel at this latitude, bilinearly resampled onto the
//                projected grid. The sample floor is held at the Badwater datum
//                so that a coastal cell which catches a little continental shelf
//                in its bilinear footprint cannot cut a trench inside the shore.
//
// SCALE
//   Plan view : {proj_w/1000:.1f} km east-west x {proj_h/1000:.1f} km north-south, carved at
//               {map_w_mm:.2f} mm x {MAP_HEIGHT_MM:.2f} mm -- about 1 mm to {km_per_mm:.2f} km.
//   Elevation : {lo:.0f} m (Badwater Basin) to {hi:.0f} m, spread over {(1-PLINTH_FRACTION)*100:.0f}% of the carve
//               depth. The Sierra crest reads {hi:.0f} m rather than Whitney's 4421
//               because a ~1 km posting averages a summit away; the ridge line is
//               right, the last 450 m of the peak is not there to be carved.
//               At plan scale that range would stand {true_mm:.3f} mm proud, so the
//               {carved_mm:.2f} mm of carved terrain exaggerates height {exagg:.0f}x.
//   Depth     : {carve_depth_mm:.1f} mm, chosen. Z runs from the Sierra crest at the stock's
//               top face down to the background floor at -{carve_depth_mm:.1f}, with the
//               coastline cut to Z {coast_mm:.1f} and Badwater at {-carve_depth_mm + PLINTH_FRACTION * carve_depth_mm:.1f}.
//
//               {exagg:.0f}x is far past what a relief map would use -- this preset is a
//               sculpture of California, not a scale model of it. Carved at true
//               vertical scale the whole Sierra would be {true_mm:.3f} mm proud of the
//               coast, which reads as a flat board, so every relief exaggerates;
//               this one just commits. What it costs is that slopes go near
//               vertical, so the tool has to be able to reach {carve_depth_mm:.0f} mm down a
//               steep wall -- see the settings at the bottom of this file.
//
// The remaining {PLINTH_FRACTION*100:.0f}% of the depth is a plinth under the lowest land, which is
// what gives the coastline a crisp step to stand proud of the background rather
// than fading into it at the floor.
//
// Regenerated by scripts/gen_california_relief.py -- the grid below is not
// hand-editable. The script re-fetches its sources, so a rerun needs a network.

import type {{ SceneGraph }} from '../types/scene';
import type {{ ReliefCarveOptions }} from '../utils/reliefCarveExporter';

/** Grid columns, west to east. */
export const CA_COLS = {cols};
/** Grid rows, south to north. */
export const CA_ROWS = {rows};
/** Carved plan-view size in mm. Height is the {MAP_HEIGHT_MM:.0f} mm the design is pinned to. */
export const CA_MAP_WIDTH_MM = {map_w_mm:.4f};
export const CA_MAP_HEIGHT_MM = {MAP_HEIGHT_MM};
/** Projected aspect ratio, width / height. */
export const CA_ASPECT = {aspect:.6f};
/** Relief depth the design works out to, in mm. See the note on exaggeration above. */
export const CA_CARVE_DEPTH_MM = {carve_depth_mm:.3f};
/** How much the height is stretched relative to the plan. */
export const CA_EXAGGERATION = {exagg:.1f};
/** Elevation the quantised grid's 0 and 255 stand for, in metres. */
export const CA_ELEV_MIN_M = {lo:.1f};
export const CA_ELEV_MAX_M = {hi:.1f};
/** Share of the model's total height that sits below the lowest land. */
export const CA_PLINTH_FRACTION = {PLINTH_FRACTION};

// A bit-packed land mask (row-major, south row first) followed by one byte of
// elevation per cell. Base64 rather than a number literal: the same data as an
// array of {cols * rows} integers is about six times the source size, and this file
// is read by people who want the projection notes at the top, not the samples.
const CA_GRID_B64 =
  '{payload}';

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decodes the payload without `atob` or `Buffer`.
 *
 * Neither is portable across the three places this module is loaded — a browser
 * has `atob` and no `Buffer`, a bare node test run has the reverse, and reaching
 * for whichever exists means the preset's type-checking depends on which one the
 * tsconfig happens to know about. Twelve lines avoids the question.
 */
function decodeBase64(s: string): Uint8Array {{
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((s.length / 4) * 3 - pad);
  let out = 0;
  for (let i = 0; i < s.length; i += 4) {{
    const n =
      (B64_ALPHABET.indexOf(s[i]) << 18) |
      (B64_ALPHABET.indexOf(s[i + 1]) << 12) |
      (Math.max(0, B64_ALPHABET.indexOf(s[i + 2])) << 6) |
      Math.max(0, B64_ALPHABET.indexOf(s[i + 3]));
    if (out < bytes.length) bytes[out++] = (n >> 16) & 0xff;
    if (out < bytes.length) bytes[out++] = (n >> 8) & 0xff;
    if (out < bytes.length) bytes[out++] = n & 0xff;
  }}
  return bytes;
}}

function decodeGrid(): {{ mask: Uint8Array; elev: Uint8Array }} {{
  const bytes = decodeBase64(CA_GRID_B64);
  const cells = CA_COLS * CA_ROWS;
  const packedLen = Math.ceil(cells / 8);
  const mask = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {{
    mask[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  }}
  return {{ mask, elev: bytes.subarray(packedLen, packedLen + cells) }};
}}

export interface CaliforniaMesh {{
  vertices: number[];
  faces: number[];
  /** Land cells that made it into the surface. */
  landCells: number;
}}

/**
 * Expands the grid into a closed solid.
 *
 * Closed, not a bare surface, for two reasons. The relief exporter drops a ray
 * down each grid cell and keeps the highest triangle, which an open sheet would
 * satisfy -- but it also checks each solid's signed volume to decide whether the
 * winding is inside out, and an open sheet has no volume to sign. And the 3D
 * viewport draws this thing; a state with no sides to it looks like a decal.
 *
 * Vertices come out in three.js Y-up space, which is what a mesh geom's
 * `vertices` field is defined to hold: x east, y elevation, z south.
 */
export function buildCaliforniaMesh(): CaliforniaMesh {{
  const {{ mask, elev }} = decodeGrid();

  const cols = CA_COLS;
  const rows = CA_ROWS;
  // Scene units are metres and the exporter reads 1 m as 1000 mm, so a 120 mm
  // map is authored 0.120 long and carves at 100% scale with no fitting.
  const w = CA_MAP_WIDTH_MM / 1000;
  const h = CA_MAP_HEIGHT_MM / 1000;
  const dx = w / cols;
  const dy = h / rows;

  // The mesh is built at the proportions it is meant to be carved at, so a
  // carve depth of CA_CARVE_DEPTH_MM reproduces this solid exactly. That matters
  // because the exporter can either stretch the model's height range onto the
  // carve depth or keep it on the plan scale, and if the mesh were authored at
  // some other height the two would disagree about what the model looks like.
  // Terrain occupies 1 - plinth of that depth; the plinth is the rest.
  const depth = CA_CARVE_DEPTH_MM / 1000;
  const terrainSpan = depth * (1 - CA_PLINTH_FRACTION);
  const baseY = -depth * CA_PLINTH_FRACTION;
  const cellY = (i: number) => (elev[i] / 255) * terrainSpan;

  const at = (c: number, r: number) => r * cols + c;
  const isLand = (c: number, r: number) =>
    c >= 0 && c < cols && r >= 0 && r < rows && mask[at(c, r)] === 1;

  // Corner heights: the mean of whatever land cells touch that corner. A corner
  // with no land under it is never referenced.
  const cw = cols + 1;
  const cornerY = new Float64Array(cw * (rows + 1));
  const cornerN = new Uint8Array(cw * (rows + 1));
  for (let r = 0; r < rows; r++) {{
    for (let c = 0; c < cols; c++) {{
      if (mask[at(c, r)] !== 1) continue;
      const y = cellY(at(c, r));
      for (const [oc, or_] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {{
        const k = (r + or_) * cw + (c + oc);
        cornerY[k] += y;
        cornerN[k]++;
      }}
    }}
  }}
  for (let k = 0; k < cornerY.length; k++) if (cornerN[k] > 0) cornerY[k] /= cornerN[k];

  const vertices: number[] = [];
  const faces: number[] = [];
  const pushVert = (x: number, y: number, z: number) => {{
    vertices.push(x, y, z);
    return vertices.length / 3 - 1;
  }};

  // Plan-view position of a grid corner, centred on the origin. z is negated
  // because Y-up space runs +z south while the grid runs north.
  const px = (c: number) => -w / 2 + c * dx;
  const pz = (r: number) => h / 2 - r * dy;

  // Vertex indices are memoised per corner so adjacent quads share them and the
  // solid is actually welded rather than a soup of loose triangles.
  const topIdx = new Int32Array(cw * (rows + 1)).fill(-1);
  const botIdx = new Int32Array(cw * (rows + 1)).fill(-1);
  const top = (c: number, r: number) => {{
    const k = r * cw + c;
    if (topIdx[k] < 0) topIdx[k] = pushVert(px(c), cornerY[k], pz(r));
    return topIdx[k];
  }};
  const bot = (c: number, r: number) => {{
    const k = r * cw + c;
    if (botIdx[k] < 0) botIdx[k] = pushVert(px(c), baseY, pz(r));
    return botIdx[k];
  }};

  let landCells = 0;
  for (let r = 0; r < rows; r++) {{
    for (let c = 0; c < cols; c++) {{
      if (mask[at(c, r)] !== 1) continue;
      landCells++;

      // Top surface, wound counter-clockwise seen from above (+y).
      const a = top(c, r), b = top(c + 1, r), d = top(c + 1, r + 1), e = top(c, r + 1);
      faces.push(a, e, d, a, d, b);

      // Underside, wound the other way so the solid's normals all point out.
      const a2 = bot(c, r), b2 = bot(c + 1, r), d2 = bot(c + 1, r + 1), e2 = bot(c, r + 1);
      faces.push(a2, d2, e2, a2, b2, d2);

      // A wall on every edge the coast or the state line runs along.
      if (!isLand(c, r - 1)) faces.push(a, b, b2, a, b2, a2);
      if (!isLand(c + 1, r)) faces.push(b, d, d2, b, d2, b2);
      if (!isLand(c, r + 1)) faces.push(d, e, e2, d, e2, d2);
      if (!isLand(c - 1, r)) faces.push(e, a, a2, e, a2, e2);
    }}
  }}

  return {{ vertices, faces, landCells }};
}}

const caMesh = buildCaliforniaMesh();

export const californiaReliefPreset: SceneGraph = {{
  nodes: [
    {{
      id: 'california',
      name: 'california',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        {{
          name: 'california_terrain',
          type: 'mesh',
          size: [1],
          vertices: caMesh.vertices,
          faces: caMesh.faces,
          rgba: [0.72, 0.66, 0.52, 1],
          // Scenery, not a participant: this is a model to be carved, and a
          // six-figure triangle mesh handed to the collider costs a great deal
          // to convex-decompose for a body that never moves.
          contype: 0,
          conaffinity: 0,
        }},
      ],
      joints: [],
      children: [],
    }},
  ],
}};

/**
 * What this model is, as far as the carve exporter is concerned: a {STOCK_W_MM:.0f} x {STOCK_D_MM:.0f} x {STOCK_T_MM:.0f} mm
 * block with the map pinned to {MAP_HEIGHT_MM:.0f} mm north-south and cut {carve_depth_mm:.0f} mm deep.
 *
 * `manual` at 100% rather than `fit` is the whole point. Fitting would scale the
 * state to fill the stock, and the depth is derived from the plan size, so a
 * plan the design did not choose gives an exaggeration it did not choose either.
 * The size is carried by the mesh being authored at {MAP_HEIGHT_MM/1000:.3f} m and the exporter
 * being told not to rescale it.
 *
 * There is deliberately no tooling in here. Which cutter reaches the bottom of a
 * {carve_depth_mm:.0f} mm wall, how fast it should be fed and what it has to be ground on are
 * facts about a machine and a workshop, not about California. The exporter works
 * them out from the depth and the plan size -- see `recommendReliefTooling` --
 * which is also what lets this model be carved on stock it was never designed
 * for. What belongs here is the object: how big it is, how deep it is, and that
 * its height is already in the mesh rather than something to be stretched onto
 * the stock.
 */
export const CALIFORNIA_RELIEF_SETTINGS: Partial<ReliefCarveOptions> = {{
  stockWidthMm: {STOCK_W_MM:.0f},
  stockDepthMm: {STOCK_D_MM:.0f},
  stockThicknessMm: {STOCK_T_MM:.0f},
  carveDepthMm: CA_CARVE_DEPTH_MM,
  // The mesh is authored at exactly these proportions, so 'fill' and
  // 'proportional' at 1x agree; 'fill' is kept because it is the exporter's
  // default and needs no exaggeration figure alongside it.
  verticalScaleMode: 'fill',
  verticalExaggeration: 1,
  fitMode: 'manual',
  scalePercent: 100,
  // The state has to stand proud of something, so the sea is cut away too.
  backgroundMode: 'carve',
}};
'''
    with open(TS_PATH, "w") as fh:
        fh.write(src)
    print(f"wrote {TS_PATH} ({os.path.getsize(TS_PATH)} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
