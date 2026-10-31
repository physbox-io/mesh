import { BufferAttribute, BufferGeometry } from 'three';

/**
 * The geometry with its vertex colours as RGBA, which is how the tracer fills
 * them in for every geometry that has none. Painted bodies carry RGB, and the
 * tracer's merge (three-gpu-pathtracer 0.0.24, mergeGeometries) handles a
 * colour attribute of the other size by copying backwards, from the merged
 * buffer into the source, so a painted body traced with colour 0: black.
 * Shares every other attribute with the live geometry; the copy is kept per
 * geometry and refilled when the paint changes.
 */
const rgbaCopies = new WeakMap<BufferGeometry, { geometry: BufferGeometry; version: number }>();
export function withRgbaColors(geometry: BufferGeometry): BufferGeometry {
  const color = geometry.getAttribute('color') as BufferAttribute | undefined;
  if (!color || color.itemSize === 4) return geometry;
  let copy = rgbaCopies.get(geometry);
  if (!copy || copy.geometry.getAttribute('color').count !== color.count) {
    const g = new BufferGeometry();
    g.setAttribute('color', new BufferAttribute(new Float32Array(color.count * 4), 4));
    copy = { geometry: g, version: -1 };
    rgbaCopies.set(geometry, copy);
  }
  // The rest is shared, and taken afresh each time in case the live geometry
  // has been given new arrays since.
  const g = copy.geometry;
  g.setIndex(geometry.index);
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    if (name !== 'color') g.setAttribute(name, attr);
  }
  g.clearGroups();
  for (const group of geometry.groups) g.addGroup(group.start, group.count, group.materialIndex);
  if (copy.version !== color.version) {
    const rgba = copy.geometry.getAttribute('color') as BufferAttribute;
    for (let i = 0; i < color.count; i++) {
      rgba.setXYZW(i, color.getX(i), color.getY(i), color.getZ(i), color.itemSize > 3 ? color.getW(i) : 1);
    }
    rgba.needsUpdate = true;
    copy.version = color.version;
  }
  return copy.geometry;
}
