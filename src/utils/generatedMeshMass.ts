/**
 * What a generated mesh geom (a sculpt's clay, a lattice's skin) is told about
 * its weight.
 *
 * These used to be written with `mass: 1` whatever their size, so a 40 mm
 * sculpted horse weighed exactly a kilogram and a 400 mm one did too. A mass
 * that is stated is still honoured, and wins; otherwise a stated density is
 * passed on, and with neither the geom says nothing and MuJoCo weighs it by its
 * volume at 1000 kg/m³, as it does every primitive built over MCP. A closed
 * mesh is integrated exactly (see GUIDE.md § What a mesh body weighs), and the
 * figure follows the shape through every later stroke, extrude and resize,
 * which a number worked out once at creation would not.
 */
export function generatedMeshMass(spec: { mass?: unknown; density?: unknown } | null | undefined): { mass?: number; density?: number } {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const mass = spec?.mass;
  const density = spec?.density;
  if (ok(mass)) return { mass };
  if (ok(density)) return { density };
  return {};
}
