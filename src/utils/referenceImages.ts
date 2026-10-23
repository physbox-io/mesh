import type { ReferenceImage, ReferencePlane } from '../types/scene';
import type { SceneBounds } from './frameScene';

/**
 * Reference images: pictures pinned in the viewport to model from.
 *
 * They live on the scene graph (SceneGraph.referenceImages), so they are saved,
 * shared, undone and reloaded with the scene they belong to, and are drawn by
 * components/scene/ReferenceImages.tsx with an unlit material - which is what
 * keeps them out of every export (useMeshExport takes lit meshes only) - and
 * with picking switched off.
 */

export const REFERENCE_PLANES: ReferencePlane[] = ['front', 'side', 'top'];

/** Longest side a stored picture is cut down to. Plenty to trace from, and a few hundred KB. */
export const REFERENCE_MAX_PX = 1600;

/**
 * The plane's own axes in world space (MuJoCo, Z up): `right` runs along the
 * picture's width, `up` along its height, `normal` out of its face towards the
 * viewer. Each matches the drawing view of the same name (physics_set_camera
 * presets), so a front picture reads the right way round in the front view.
 */
export function planeAxes(plane: ReferencePlane): { right: [number, number, number]; up: [number, number, number]; normal: [number, number, number] } {
  switch (plane) {
    case 'side': return { right: [0, 1, 0], up: [0, 0, 1], normal: [1, 0, 0] };
    case 'top': return { right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1] };
    default: return { right: [1, 0, 0], up: [0, 0, 1], normal: [0, -1, 0] };
  }
}

/** Width a new picture comes in at with nothing in the scene: about the default view's width. */
export const REFERENCE_DEFAULT_WIDTH = 0.12;

/**
 * Where a new picture goes: in the plane of its view, centred on what the scene
 * already holds and as wide as it (so it comes in at the scale of the model it
 * is for), and for a front or side view standing on the floor. An explicit
 * `width` wins over the scene's.
 */
export function defaultPlacement(
  plane: ReferencePlane, aspect: number, bounds: SceneBounds | null, width?: number,
): Pick<ReferenceImage, 'pos' | 'width'> {
  const { right } = planeAxes(plane);
  const axis = right.indexOf(1);
  const span = bounds ? bounds.max[axis] - bounds.min[axis] : 0;
  const w = width ?? (span > 0.005 ? span : REFERENCE_DEFAULT_WIDTH);
  const c = bounds ? bounds.min.map((v, i) => (v + bounds.max[i]) / 2) : [0, 0, 0];
  if (plane === 'top') return { width: w, pos: [c[0], c[1], 0.0005] };
  const h = w / aspect;
  return { width: w, pos: [c[0], c[1], h / 2] };
}

/** The height of a picture in the world, metres. */
export function referenceHeight(img: Pick<ReferenceImage, 'width' | 'aspect'>): number {
  return img.width / img.aspect;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A partial update read from an agent's message, checked field by field. Numbers
 * may arrive as numeric strings. Throws on anything it cannot read, naming the
 * field, rather than storing a picture nobody can see.
 */
export function readReferencePatch(msg: Record<string, unknown>): Partial<Omit<ReferenceImage, 'id' | 'src' | 'aspect'>> {
  const num = (k: string, v: unknown): number => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (!finite(n)) throw new Error(`${k} must be a number`);
    return n;
  };
  const out: Partial<Omit<ReferenceImage, 'id' | 'src' | 'aspect'>> = {};
  if (msg.name !== undefined) out.name = String(msg.name);
  if (msg.plane !== undefined) {
    if (!REFERENCE_PLANES.includes(msg.plane as ReferencePlane)) throw new Error(`plane must be one of ${REFERENCE_PLANES.join(', ')}`);
    out.plane = msg.plane as ReferencePlane;
  }
  if (msg.center !== undefined) {
    if (!Array.isArray(msg.center) || msg.center.length !== 3) throw new Error('center must be [x, y, z] in metres');
    out.pos = msg.center.map((v, i) => num(`center[${i}]`, v)) as [number, number, number];
  }
  if (msg.width !== undefined) {
    const w = num('width', msg.width);
    if (w <= 0 || w > 20) throw new Error('width must be more than 0 and at most 20 m');
    out.width = w;
  }
  if (msg.opacity !== undefined) {
    const o = num('opacity', msg.opacity);
    if (o < 0 || o > 1) throw new Error('opacity must be between 0 and 1');
    out.opacity = o;
  }
  if (msg.overlay !== undefined) out.overlay = msg.overlay !== false && msg.overlay !== 'false';
  if (msg.hidden !== undefined) out.hidden = msg.hidden !== false && msg.hidden !== 'false';
  return out;
}

/**
 * A new picture, or `patch` laid over the one with `id`. Pure: returns a new
 * list. A height given instead of a width is turned into one by the aspect.
 */
export function upsertReferenceImage(
  list: readonly ReferenceImage[] | undefined,
  id: string | undefined,
  patch: Partial<ReferenceImage> & { height?: number },
  bounds: SceneBounds | null,
): { images: ReferenceImage[]; image: ReferenceImage } {
  const images = [...(list ?? [])];
  const { height, ...rest } = patch;
  const at = id ? images.findIndex((r) => r.id === id) : -1;
  if (id && at < 0) throw new Error(`No reference image with id '${id}'`);
  const base = at >= 0 ? images[at] : null;
  const aspect = rest.aspect ?? base?.aspect;
  if (!aspect || !(aspect > 0)) throw new Error('A new reference image needs a picture');
  if (height !== undefined && rest.width === undefined) rest.width = height * aspect;
  const plane = rest.plane ?? base?.plane ?? 'front';
  const placed = base ?? {
    id: id ?? `ref_${Math.random().toString(36).slice(2, 10)}`,
    name: 'Reference',
    src: '',
    aspect,
    plane,
    opacity: 0.5,
    overlay: true,
    ...defaultPlacement(plane, aspect, bounds, rest.width),
  };
  const image: ReferenceImage = { ...placed, ...rest, aspect, plane };
  if (at >= 0) images[at] = image;
  else images.push(image);
  return { images, image };
}

/** What an agent is told about a picture: everything but the pixels. */
export function describeReferenceImage(img: ReferenceImage) {
  return {
    id: img.id,
    name: img.name,
    plane: img.plane,
    center: img.pos,
    widthMm: +(img.width * 1000).toFixed(2),
    heightMm: +(referenceHeight(img) * 1000).toFixed(2),
    opacity: img.opacity,
    overlay: img.overlay,
    ...(img.hidden ? { hidden: true } : {}),
  };
}

/**
 * A picture file or data URL, decoded and cut down to REFERENCE_MAX_PX on its
 * longest side, as a JPEG unless it has transparency. Browser only.
 */
export async function normalizeReferencePicture(source: Blob | string): Promise<{ src: string; aspect: number }> {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The browser could not decode this picture.'));
      img.src = url;
    });
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    if (!w0 || !h0) throw new Error('The picture has no size.');
    const scale = Math.min(1, REFERENCE_MAX_PX / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not open a 2D canvas to read the picture.');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // A JPEG is a fifth the size of a PNG photo; only a picture that is really
    // see-through somewhere (line art on nothing) is worth keeping as a PNG.
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let seeThrough = false;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] < 250) { seeThrough = true; break; }
    }
    return { src: seeThrough ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.88), aspect: w0 / h0 };
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}
