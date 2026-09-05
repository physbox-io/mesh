import { describe, it, expect } from 'vitest';
import { icosphere, meshBounds, recomputeNormals, toSceneGeom, fromSceneGeom } from '../src/utils/sculptMesh';
import { buildSculptBase, SCULPT_BASES } from '../src/utils/sculptBases';
import {
  applySculptStroke,
  resolveStamp,
  sculptSummary,
  verticesNear,
  probeSurface,
  undoSculptStroke,
  BRUSH_TYPES,
} from '../src/utils/sculptCommands';

/**
 * Sculpting driven by coordinates instead of a cursor.
 *
 * The interesting cases are the ones a mouse cannot get wrong: a point that is
 * nowhere near the surface, a point on the far side of the model, a brush that
 * needs a drag direction nobody supplied.
 */

const ball = () => {
  const mesh = icosphere(0.1, 3);
  recomputeNormals(mesh);
  return mesh;
};

describe('resolveStamp', () => {
  it('snaps a point floating off the surface onto the nearest bit of it', () => {
    const mesh = ball();
    // Well outside a 0.1m ball, straight up.
    const stamp = resolveStamp(mesh, [0, 0, 0.13], 0.05)!;
    expect(stamp).not.toBeNull();
    expect(Math.hypot(stamp.x, stamp.y, stamp.z)).toBeCloseTo(0.1, 2);
    // The normal at the top of a ball points up.
    expect(stamp.nz).toBeGreaterThan(0.8);
  });

  it('refuses a point in mid-air rather than dragging it onto the far side', () => {
    const mesh = ball();
    expect(resolveStamp(mesh, [0, 0, 5], 0.05)).toBeNull();
  });

  it('hands back the point that would have worked, so a miss is correctable', () => {
    const mesh = ball();
    const [miss] = applySculptStroke(mesh, {
      brush: 'draw', at: [[0, 0, 5]], radius: 0.04, strength: 1,
    }).missed;
    expect(miss.distance).toBeCloseTo(4.9, 1);
    // Feeding `nearest` straight back in lands the dab.
    const retry = applySculptStroke(mesh, {
      brush: 'draw', at: [miss.nearest!], radius: 0.04, strength: 1,
    });
    expect(retry.applied).toBe(1);
    expect(retry.missed).toEqual([]);
  });

  it('tells the two poles apart', () => {
    const mesh = ball();
    const top = resolveStamp(mesh, [0, 0, 0.1], 0.05)!;
    const bottom = resolveStamp(mesh, [0, 0, -0.1], 0.05)!;
    expect(top.z).toBeGreaterThan(0);
    expect(bottom.z).toBeLessThan(0);
    expect(top.nz).toBeGreaterThan(0);
    expect(bottom.nz).toBeLessThan(0);
  });
});

describe('applySculptStroke', () => {
  it('pushes the surface out where it was asked to and nowhere else', () => {
    const mesh = ball();
    const before = meshBounds(mesh);
    applySculptStroke(mesh, { brush: 'draw', at: [[0, 0, 0.1]], radius: 0.04, strength: 1 });
    const after = meshBounds(mesh);
    // The top moved up; the bottom stayed where it was.
    expect(after.max[2]).toBeGreaterThan(before.max[2]);
    expect(after.min[2]).toBeCloseTo(before.min[2], 3);
  });

  it('reports what it moved, for a stroke the bounding box cannot show', () => {
    /*
     * A dab on the side of a head moves the cheek; the widest point of the model
     * is still the back of the skull, so bounds, vertex count and face count all
     * come back untouched. `moved` is the only thing that says the stroke did
     * anything, and a caller with no view of the surface has nothing else.
     */
    const mesh = buildSculptBase('head');
    const before = meshBounds(mesh);
    const result = applySculptStroke(mesh, {
      brush: 'draw', at: [[0.104, 0, 0.02]], radius: 0.035, strength: 1, dynamicTopology: false,
    });

    expect(result.applied).toBe(1);
    expect(result.moved).toBeGreaterThan(0);
    expect(result.maxDisplacement).toBeGreaterThan(0.001);
    // ...and the bounds really are unchanged, which is the whole point.
    expect(meshBounds(mesh).max).toEqual(before.max);
  });

  it('reports nothing moved when every dab missed', () => {
    const mesh = ball();
    const result = applySculptStroke(mesh, { brush: 'draw', at: [[0, 0, 9]], radius: 0.04, strength: 1 });
    expect(result.applied).toBe(0);
    expect(result.moved).toBe(0);
    expect(result.maxDisplacement).toBe(0);
  });

  it('carves in when inverted', () => {
    const mesh = ball();
    const before = meshBounds(mesh);
    applySculptStroke(mesh, { brush: 'draw', at: [[0, 0, 0.1]], radius: 0.04, strength: 1, invert: true });
    expect(meshBounds(mesh).max[2]).toBeLessThan(before.max[2]);
  });

  it('reports the points that found no surface instead of failing the whole stroke', () => {
    const mesh = ball();
    const result = applySculptStroke(mesh, {
      brush: 'draw',
      at: [[0, 0, 0.1], [0, 0, 9]],
      radius: 0.04,
      strength: 1,
    });
    expect(result.applied).toBe(1);
    expect(result.missed).toHaveLength(1);
    expect(result.missed[0].at).toEqual([0, 0, 9]);
  });

  it('mirrors a stroke across X when symmetry is on', () => {
    const mesh = ball();
    applySculptStroke(mesh, {
      brush: 'draw', at: [[0.1, 0, 0]], radius: 0.04, strength: 1, symmetryX: true,
    });
    const bounds = meshBounds(mesh);
    // Both ends of the X axis grew, from the one dab.
    expect(bounds.max[0]).toBeGreaterThan(0.1);
    expect(bounds.min[0]).toBeLessThan(-0.1);
  });

  it('mirrors in the plane asked for, which is how a pair is made', () => {
    /*
     * The figure bases face +X, so left and right lie along Y. Mirroring X on a
     * head reflects front to back — a nose with a second nose behind it — and no
     * amount of it will produce a matching pair of ears. The plane has to be
     * choosable, and 'x' stays the default so nothing that relied on the old
     * behaviour changes.
     */
    const acrossY = ball();
    applySculptStroke(acrossY, {
      brush: 'draw', at: [[0, 0.1, 0]], radius: 0.04, strength: 1, symmetry: 'y',
    });
    const yBounds = meshBounds(acrossY);
    expect(yBounds.max[1]).toBeGreaterThan(0.1);
    expect(yBounds.min[1]).toBeLessThan(-0.1);
    // ...and the X axis, which was not the mirror plane, is untouched.
    expect(yBounds.max[0]).toBeCloseTo(0.1, 3);

    const acrossX = ball();
    applySculptStroke(acrossX, {
      brush: 'draw', at: [[0, 0.1, 0]], radius: 0.04, strength: 1, symmetry: 'x',
    });
    // Mirroring X puts the second dab back on top of the first, so only +Y grew.
    const xBounds = meshBounds(acrossX);
    expect(xBounds.max[1]).toBeGreaterThan(0.1);
    expect(xBounds.min[1]).toBeCloseTo(-0.1, 3);
  });

  it('leaves the far side alone without symmetry', () => {
    const mesh = ball();
    applySculptStroke(mesh, { brush: 'draw', at: [[0.1, 0, 0]], radius: 0.04, strength: 1 });
    const bounds = meshBounds(mesh);
    expect(bounds.max[0]).toBeGreaterThan(0.1);
    expect(bounds.min[0]).toBeCloseTo(-0.1, 3);
  });

  it('adds detail as it goes, and stops when told not to', () => {
    const grown = ball();
    applySculptStroke(grown, {
      brush: 'draw', at: [[0, 0, 0.1]], radius: 0.05, strength: 1, dynamicTopology: true, detail: 0.2,
    });

    const flat = ball();
    const before = flat.vertexCount;
    applySculptStroke(flat, {
      brush: 'draw', at: [[0, 0, 0.1]], radius: 0.05, strength: 1, dynamicTopology: false,
    });

    expect(grown.vertexCount).toBeGreaterThan(before);
    expect(flat.vertexCount).toBe(before);
  });

  it('drags the caught surface for grab, which needs a delta', () => {
    const pulled = ball();
    applySculptStroke(pulled, {
      brush: 'grab', at: [[0, 0, 0.1]], radius: 0.04, strength: 1, delta: [0, 0, 0.05],
    });
    const still = ball();
    applySculptStroke(still, { brush: 'grab', at: [[0, 0, 0.1]], radius: 0.04, strength: 1 });

    expect(meshBounds(pulled).max[2]).toBeGreaterThan(meshBounds(still).max[2]);
  });

  it('draws a limb out, rather than stretching a fin', () => {
    /*
     * The failure this covers: a grab used to drag the vertices it caught and
     * add none, so pulling a leg out of a body stretched forty-odd vertices
     * across five centimetres. That is not a leg, it is a flat sparse sheet —
     * and no amount of inflating or smoothing afterwards rounds it out, because
     * there is nothing there to round.
     *
     * Measured by cross-section: count the vertices in a thin slab across the
     * middle of the pulled limb. A fin has a handful; a limb has a ring of them.
     */
    const pull = (dynamicTopology: boolean) => {
      const mesh = ball();
      applySculptStroke(mesh, {
        brush: 'grab', at: [[0, 0, 0.1]], radius: 0.02, strength: 1,
        delta: [0, 0, 0.06], dynamicTopology, detail: 0.25,
      });
      // A slab across the limb, halfway along what was dragged.
      const midZ = 0.13;
      let inSlab = 0;
      for (let i = 0; i < mesh.vertexCount; i++) {
        if (Math.abs(mesh.positions[i * 3 + 2] - midZ) < 0.006) inSlab++;
      }
      return { vertices: mesh.vertexCount, inSlab };
    };

    const fin = pull(false);
    const limb = pull(true);

    expect(limb.vertices).toBeGreaterThan(fin.vertices);
    // The whole point: the drawn-out neck has real surface around it now.
    expect(limb.inSlab).toBeGreaterThan(fin.inSlab * 3);
  });

  it('makes a matching PAIR with a symmetric grab, not one lump torn in half', () => {
    /*
     * Grab holds the vertices it caught on its first stamp, so the lump travels
     * with the cursor instead of the brush picking up whatever it passes over.
     * A symmetric stroke lands twice — once where aimed, once mirrored — and
     * both stamps used to share that one held set. So the mirrored stamp
     * re-dragged the FIRST stamp's vertices in the opposite direction: one lump
     * pulled apart down the middle, and never a second limb.
     *
     * Which meant no pair of legs, wings or horns could be sculpted with
     * symmetry on — exactly when you would reach for it.
     */
    const mesh = ball();
    applySculptStroke(mesh, {
      brush: 'grab',
      at: [[0, 0.07, -0.07]],
      radius: 0.02,
      strength: 1,
      symmetry: 'y',
      delta: [0, 0, -0.06],
      dynamicTopology: true,
      detail: 0.25,
    });

    // Anything pulled below the ball is new: count it on each side of y=0.
    let leftLimb = 0;
    let rightLimb = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      if (mesh.positions[i * 3 + 2] >= -0.105) continue;
      if (mesh.positions[i * 3 + 1] > 0.01) leftLimb++;
      else if (mesh.positions[i * 3 + 1] < -0.01) rightLimb++;
    }

    expect(leftLimb).toBeGreaterThan(0);
    expect(rightLimb).toBeGreaterThan(0);
    // And the two are the same limb mirrored, not one big one and a stray.
    const larger = Math.max(leftLimb, rightLimb);
    const smaller = Math.min(leftLimb, rightLimb);
    expect(smaller / larger).toBeGreaterThan(0.6);
  });

  it('adds nothing on a grab when dynamic topology is off', () => {
    const mesh = ball();
    const before = mesh.vertexCount;
    applySculptStroke(mesh, {
      brush: 'grab', at: [[0, 0, 0.1]], radius: 0.02, strength: 1,
      delta: [0, 0, 0.05], dynamicTopology: false,
    });
    expect(mesh.vertexCount).toBe(before);
  });

  it('runs every brush without breaking the mesh', () => {
    for (const brush of BRUSH_TYPES) {
      const mesh = ball();
      const result = applySculptStroke(mesh, {
        brush, at: [[0, 0, 0.1]], radius: 0.04, strength: 0.6, delta: [0, 0, 0.01],
      });
      expect(result.vertices).toBeGreaterThan(0);
      expect(result.faces).toBeGreaterThan(0);
      expect(Number.isFinite(mesh.positions[0])).toBe(true);
    }
  });

  it('survives a round trip through the scene graph', () => {
    // How a sculpt actually reaches the bridge: as geom arrays on a node, not
    // as a SculptMesh. A stroke has to mean the same thing after that trip.
    const mesh = ball();
    applySculptStroke(mesh, { brush: 'draw', at: [[0, 0, 0.1]], radius: 0.04, strength: 1 });
    const geom = toSceneGeom(mesh);

    const restored = fromSceneGeom(geom.renderVertices, geom.faces);
    expect(restored.vertexCount).toBe(mesh.vertexCount);
    expect(meshBounds(restored).max[2]).toBeCloseTo(meshBounds(mesh).max[2], 6);
  });
});

describe('reading a sculpt back', () => {
  it('summarises size and watertightness without the vertex list', () => {
    const summary = sculptSummary(ball());
    expect(summary.vertices).toBeGreaterThan(100);
    expect(summary.watertight).toBe(true);
    // A 0.1m-radius ball is 0.2m across in every direction.
    for (const axis of summary.size) expect(axis).toBeCloseTo(0.2, 2);
  });

  it('counts the vertices under a point, so a stroke can be checked', () => {
    const mesh = ball();
    expect(verticesNear(mesh, [0, 0, 0.1], 0.05)).toBeGreaterThan(0);
    expect(verticesNear(mesh, [0, 0, 9], 0.05)).toBe(0);
  });
});

describe('every base is sculptable as shipped', () => {
  it.each(SCULPT_BASES.map((b) => b.id))('%s', (id) => {
    const mesh = buildSculptBase(id);
    const summary = sculptSummary(mesh);
    expect(summary.vertices).toBeGreaterThan(0);
    expect(summary.faces).toBeGreaterThan(0);

    // A point taken off the surface itself must always land, whatever the shape.
    const onSurface = [mesh.positions[0], mesh.positions[1], mesh.positions[2]];
    const result = applySculptStroke(mesh, { brush: 'draw', at: [onSurface], radius: 0.03, strength: 0.5 });
    expect(result.applied).toBe(1);

    /*
     * And the centre of the top of the bounding box may well be thin air — it is
     * on a sphere, and nowhere near a bird. Whichever it turns out to be, the
     * caller is left able to act: either the dab landed, or the miss says where
     * the surface actually was.
     */
    const overhead = [
      (summary.bounds.min[0] + summary.bounds.max[0]) / 2,
      (summary.bounds.min[1] + summary.bounds.max[1]) / 2,
      summary.bounds.max[2],
    ];
    const guess = applySculptStroke(buildSculptBase(id), {
      brush: 'draw', at: [overhead], radius: 0.03, strength: 0.5,
    });
    if (guess.applied === 0) {
      expect(guess.missed[0].nearest).not.toBeNull();
      expect(guess.missed[0].distance).toBeGreaterThan(0);
    }
  });
});

describe('probing and undoing', () => {
  it('reports the nearest surface point and its normal, changing nothing', () => {
    const mesh = ball();
    const [probe] = probeSurface(mesh, [[0, 0, 0.5]]);
    expect(probe.distance).toBeCloseTo(0.4, 2);
    expect(Math.hypot(...(probe.nearest as number[]))).toBeCloseTo(0.1, 2);
    // Straight up off the top of a ball, so the normal points up.
    expect((probe.normal as number[])[2]).toBeGreaterThan(0.8);
    expect(meshBounds(mesh).max[2]).toBeCloseTo(0.1, 3);
  });

  it('probes several points at once and marks the ones with no surface at all', () => {
    const mesh = ball();
    const probes = probeSurface(mesh, [[0, 0, 0.1], [0.1, 0, 0]]);
    expect(probes).toHaveLength(2);
    for (const p of probes) expect(p.nearest).not.toBeNull();
  });

  it('puts a stroke back exactly', () => {
    const mesh = ball();
    const before = Float32Array.from(mesh.positions.subarray(0, mesh.vertexCount * 3));

    const sink: { undo?: ReturnType<typeof applySculptStroke> extends never ? never : any } = {};
    applySculptStroke(mesh, {
      brush: 'draw', at: [[0, 0, 0.1]], radius: 0.04, strength: 1, dynamicTopology: false,
    }, sink);
    expect(meshBounds(mesh).max[2]).toBeGreaterThan(0.1);

    undoSculptStroke(mesh, sink.undo!);
    for (let i = 0; i < before.length; i++) {
      expect(mesh.positions[i]).toBeCloseTo(before[i], 6);
    }
  });

  it('puts back a stroke that changed the topology too', () => {
    const mesh = ball();
    const startVertices = mesh.vertexCount;

    const sink: { undo?: any } = {};
    applySculptStroke(mesh, {
      brush: 'draw', at: [[0, 0, 0.1]], radius: 0.05, strength: 1, dynamicTopology: true, detail: 0.2,
    }, sink);
    expect(mesh.vertexCount).toBeGreaterThan(startVertices);

    undoSculptStroke(mesh, sink.undo!);
    expect(mesh.vertexCount).toBe(startVertices);
    expect(meshBounds(mesh).max[2]).toBeCloseTo(0.1, 3);
  });
});
