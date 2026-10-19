/**
 * OpenSCAD modules Mesh puts in every compile's file system, under /physbox/.
 *
 * `use <physbox/pocket.scad>` resolves against the input file's directory,
 * which is the root, so a script can call these without carrying them. Each
 * mirrors a cutter the app builds natively, so the same recess comes out of a
 * physics_cut and a SCAD script alike.
 */

/**
 * pocket(): the smooth recess of utils/pocketCutter.ts — concentric insets of
 * a rounded rectangle or an ellipse, dropping by a flat-with-fillet or a bowl
 * profile — rim on z = 0 going down, a collar `overshoot` above it so the
 * difference() never ends flush. Millimetres.
 */
export const POCKET_SCAD = `// Smooth pocket / dish cutter. Subtract it with difference().
// pocket(width, length, depth, corner_r = 0, floor = "flat", floor_r = -1, outline = "rect")
//   outline  "rect" (rounded rectangle, corner_r) or "ellipse"
//   floor    "flat" (flat floor, fillet of floor_r, default depth/4) or "bowl"
module pocket(width, length, depth, corner_r = 0, floor = "flat", floor_r = -1, outline = "rect", overshoot = 1, around = 160, rings = 40) {
  function sgn(x) = x < 0 ? -1 : 1;
  s_max = min(width, length) / 2;
  s_end = s_max * 0.98;
  flat = floor != "bowl";
  fr = min(floor_r < 0 ? depth / 4 : floor_r, depth, s_max);
  function ring_pt(s, j) = let(phi = 360 * j / around, c = cos(phi), sn = sin(phi), hw = width / 2 - s, hl = length / 2 - s)
    outline == "ellipse"
      ? let(a = max(hw, 0.001), b = max(hl, 0.001), k = sqrt(a * a * c * c + b * b * sn * sn)) [a * a * c / k, b * b * sn / k]
      : let(r = min(max(corner_r - s, 0.4), hw, hl)) [sgn(c) * (hw - r) + r * c, sgn(sn) * (hl - r) + r * sn];
  function fz(s) = !flat
    ? let(t = min(1, s / s_max)) -depth * (1 - (1 - t) * (1 - t))
    : (s >= fr ? -depth : -(depth - fr) - sqrt(max(0, fr * fr - (fr - s) * (fr - s))));
  wall = (flat && depth - fr > 1e-6) ? [[0, -(depth - fr)]] : [];
  inner = [for (i = [1:rings]) let(t = i / rings, s = flat ? (i < rings ? fr * (1 - cos(90 * t)) : s_end) : s_end * (1 - cos(90 * t)))
    if (s > 0 && (s < s_end || i == rings)) [s, fz(s)]];
  rs = concat([[0, overshoot], [0, 0]], wall, inner);
  n = len(rs);
  function at(ri, j) = ri * around + (j % around);
  top = n * around;
  bottom = top + 1;
  pts = concat(
    [for (r = rs, j = [0:around - 1]) let(p = ring_pt(r[0], j)) [p[0], p[1], r[1]]],
    [[0, 0, overshoot], [0, 0, rs[n - 1][1]]]);
  faces = concat(
    [for (ri = [0:n - 2], j = [0:around - 1]) [at(ri, j), at(ri, j + 1), at(ri + 1, j + 1), at(ri + 1, j)]],
    [for (j = [0:around - 1]) [top, at(0, j + 1), at(0, j)]],
    [for (j = [0:around - 1]) [bottom, at(n - 1, j), at(n - 1, j + 1)]]);
  polyhedron(pts, faces);
}
`;

/** Every library file, by its path in the compile's file system. */
export const SCAD_LIBRARY: Record<string, string> = {
  '/physbox/pocket.scad': POCKET_SCAD,
};
