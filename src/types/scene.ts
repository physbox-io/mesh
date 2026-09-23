import type { PaintLayer } from '../utils/vertexPaint';
export type GeomType = 'capsule' | 'sphere' | 'box' | 'plane' | 'cylinder' | 'ellipsoid' | 'mesh';
export type JointType = 'hinge' | 'slide' | 'ball' | 'free';

// How a geom takes part in a body's CSG (boolean) program. Only meaningful on a
// node with csgEnabled — elsewhere every geom is an independent solid, which is
// what 'union' means anyway.
export type CsgOp = 'union' | 'difference' | 'intersection';

// What a geom is FOR. Undefined (the default, and every pre-CSG geom) means
// both: it renders and it collides, as geoms always have.
//   'visual'    — drawn, but contype/conaffinity forced to 0 and carries no mass
//   'collision' — simulated, never drawn
export type GeomRole = 'visual' | 'collision';

// How a body's geometry reaches MuJoCo's contact solver. See SceneNode.collision.
export type CollisionMode = 'auto' | 'hull' | 'decompose' | 'primitives';

export interface SceneGeom {
  /**
   * An id of its own, carried by geoms that came from the copilot (see RawGeom
   * in src/utils/sceneNodes.ts) and by the one the SCAD compile creates. Geoms
   * are addressed by `name` everywhere; nothing reads this.
   */
  id?: string;
  name: string;
  type: GeomType;
  size: number[];
  // CSG authoring (source primitives). 'difference' geoms are cut OUT of the
  // union of the body's positive geoms; they are never emitted to MJCF.
  csg?: CsgOp;
  role?: GeomRole;
  // Set on geoms *generated* by evaluating the body's CSG program — or, for a
  // body that is not a boolean at all, by decomposing its mesh into convex
  // colliders — so a recompile can replace them wholesale and tell them from
  // authored ones.
  csgDerived?: 'visual' | 'collider';
  rgba?: number[];
  // Colour brushed onto part of this geom's surface (see utils/vertexPaint).
  // Purely decorative: nothing in the physics, the MJCF emitter or any exporter
  // reads it.
  paint?: PaintLayer;
  fromto?: number[];
  pos?: number[];
  quat?: number[];
  euler?: number[];
  mass?: number;
  /**
   * What the geom is made of, in kg/m3. MuJoCo weighs a geom by its volume at
   * a default density of 1000 — water — so a body says how heavy it is either
   * by stating `mass` outright or by saying what it is made of and letting its
   * size do the rest. The second is what survives being rescaled, and it is
   * the only one that can tell a tree from a building of the same shape: oak
   * timber is about 700, concrete about 2400, and a crown of leaves, which is
   * mostly the air between them, is single digits.
   *
   * Ignored when `mass` is set, which wins.
   */
  density?: number;
  contype?: number;
  conaffinity?: number;
  condim?: number;
  friction?: number[];
  solref?: number[];
  solimp?: number[];
  margin?: number;
  gap?: number;
  /**
   * For type='mesh': the most corners MuJoCo may keep when it hulls this mesh
   * for collision (`<mesh maxhullvert>`). Drawing still uses every vertex.
   * Shards set it, because collision between mesh hulls costs more per corner
   * and nobody can see a chip's hull while it tumbles.
   */
  maxHullVert?: number;
  /**
   * For type='mesh': these vertices will not change for as long as the geom
   * exists, so the mesh may go straight into the physics worker's file cache
   * on its first build instead of waiting to prove it is stable. Shards set it.
   */
  stableMesh?: boolean;
  // For type='mesh': flat array of vertex positions (x0,y0,z0, x1,y1,z1, ...) and
  // flat array of triangle face indices (i0,j0,k0, i1,j1,k1, ...).
  // vertices are in Three.js Y-up space; the mjcf builder swaps Y↔Z for MuJoCo.
  vertices?: number[];
  faces?: number[];
  // When true, the mesh participates in simulation and its transform is tracked from MuJoCo.
  // The renderer uses renderVertices (Z-up, centroid at origin) inside the rotated group.
  dynamic?: boolean;
  /**
   * How hard this surface has to be struck before it takes a dent, in N*s.
   *
   * Undefined means it is rigid, which is what every geom was before this. A
   * steel plate given a yield of, say, 6 N*s is unmarked by anything soft or
   * slow and cratered by a dropped weight — which is the whole point: the same
   * plate, two different blows, two different outcomes.
   *
   * DENTS ARE COSMETIC. The contact solver keeps using the undented mesh,
   * because re-uploading a collision mesh means rebuilding the model and that
   * cannot happen at the rate contacts arrive. Deformation lives outside the
   * scene graph entirely (see store/dentStore.ts) and is cleared by Reset.
   */
  dentYieldNs?: number;
  /** Metres of depth per newton-second over the yield. The plasticity, near enough. */
  dentDepthPerNs?: number;
  /** Radius of the crater, in metres. Defaults to a fraction of the mesh's size. */
  dentRadius?: number;
  /** Hard cap on how deep one spot can ever be pushed, in metres. */
  dentMaxDepth?: number;
  /**
   * The blow that goes straight through, in N*s.
   *
   * Above this the surface is not dented, it is holed: the material under the
   * striker is gone rather than pushed aside. Should sit well above
   * `dentYieldNs` — a sheet that dents at 6 and pierces at 7 has no range in
   * which it behaves like a sheet.
   *
   * Cosmetic in the same way a dent is. The contact solver keeps using the
   * whole surface, so something can be thrown through a holed plate and still
   * bounce off where the hole is. Undefined means it can never be pierced.
   */
  pierceImpulseNs?: number;
  /**
   * Whether damage to this surface is real to the contact solver, or only seen.
   *
   * Off by default, and that default is not timidity — it is the only way
   * deformation can be free. A dent is a change of geometry, and geometry
   * reaches MuJoCo by compiling the scene to MJCF and building a new model, so
   * every blow that counts costs a rebuild. Off, a hundred impacts cost nothing
   * and the plate collides flat; on, each one costs a rebuild and the hole is
   * somewhere things can fall through.
   *
   * A HOLE ALSO NEEDS DECOMPOSING. MuJoCo collides a mesh as its convex hull,
   * which fills a hole straight back in, so a pierced surface with this set is
   * switched to `collision: 'decompose'` — V-HACD, which is the expensive part
   * and the reason this is a choice rather than the default.
   */
  deformCollision?: boolean;
  /**
   * For a geom that cuts (csg:'difference'): where it goes into the part, and
   * how far.
   *
   * The authoring intent, from which `pos`, `quat` and the length in `size` are
   * DERIVED — see cutGeometry in utils/csg.ts. Stored because those cannot be
   * read back into it: a cylinder from 10 to 22 is a 12 mm cutter centred at 16,
   * and recovering "10 mm in, perpendicular to that face" from it would mean
   * knowing which end was the entry and how much was overshoot.
   *
   * `cutNormal` is the OUTWARD direction of the surface, and it is a direction
   * rather than a choice of six axes on purpose. A lattice vertex is three
   * integers, but a face joining any three of them can point anywhere, and a
   * bevelled, smoothed or imported surface certainly does — snapping to the
   * nearest axis puts the hole at an angle to the face it was asked for,
   * quietly.
   *
   * Nothing downstream reads these. The boolean, the MJCF and every exporter
   * see an ordinary positioned primitive, exactly as they did before.
   */
  cutNormal?: number[];
  /** The point on that surface the cut is centred on, in the body frame. */
  cutAt?: number[];
  /** Depth in metres into the material from `cutAt`. 0 or absent cuts through. */
  cutDepth?: number;
  /**
   * A modifier on a round cut: the hole is tapped. `pitch` is the thread pitch
   * in metres; the geom's own radius is the thread's MAJOR radius (the size a
   * bolt is named by — M6 is a 6 mm major diameter), and the minor diameter
   * follows from the pitch by the ISO 60° form. Only the OpenSCAD emitter reads
   * it: the cutter becomes a helical solid instead of a plain cylinder, and
   * everything downstream sees the boolean result as usual.
   *
   * One field rather than a `modifiers` list because every modifier a hole can
   * take — a thread, a countersink, a counterbore — is a different thing with
   * different numbers, and they are not stacked in an order that matters. Each
   * gets its own optional field beside this one.
   */
  thread?: { pitch: number };
  /**
   * This is the geom the body's lattice cage owns — the one `applyLattice`
   * rewrites on every edit.
   *
   * It exists so a lattice body can carry OTHER geoms: the moment a cut is
   * added to one, "the body's mesh geom" stops naming one thing, because the
   * boolean evaluator's own output is a mesh too. Picking the first mesh in the
   * list would eventually pick the derived one and overwrite the boolean result
   * with the un-cut cage.
   */
  latticeGeom?: boolean;
  // Centroid-recentered vertices in MuJoCo Z-up space for dynamic mesh rendering.
  renderVertices?: number[];
  /**
   * The un-rotated mesh, kept so repeated absolute rotations compose from the
   * original rather than from the last result (see rotateMeshGeomsAbsolute in
   * src/store/useStore.ts). Working state: written the first time a mesh geom
   * is rotated, and carried through cloneGeom by reference like the other
   * vertex arrays.
   */
  baseVertices?: number[];
  /** The same, for the Z-up renderVertices of a dynamic mesh. */
  baseRenderVertices?: number[];
}

export interface SceneJoint {
  name: string;
  type: JointType;
  axis?: number[];
  pos?: number[];
  damping?: number;
  stiffness?: number;
  springref?: number;
  limited?: boolean;
  range?: number[];
  actuator?: {
    type: 'velocity' | 'motor';
    kv?: number; // For velocity actuators
    gear?: number; // Optional gear ratio
    ctrlValue?: number; // Target speed or force from UI
  };
  initialVelocity?: number[]; // [lin_x, lin_y, lin_z, ang_x, ang_y, ang_z]
  /**
   * The torque, in N*m, past which this joint stops being rigid and folds.
   *
   * A crumple zone: the joint is held still by an equality constraint until
   * something overloads it, and then it gives and STAYS given. That is the
   * difference between a hinge and a dent — a spring comes back, a crumpled
   * wing does not.
   *
   * Cheap because it reuses the breakable weld: the lock is an ordinary weld
   * equality between this body and its parent, emitted by the MJCF builder, and
   * releasing it is the same one-byte write to `eq_active`. Undefined means the
   * joint behaves as it always has.
   */
  crumpleTorqueNm?: number;
  /** How far it may fold once it has given, in degrees. Emitted as the joint's range. */
  crumpleRangeDeg?: [number, number];
  /**
   * Damping written into the joint at the moment it gives, in N*m*s.
   *
   * High, normally. Without it the released joint swings freely and the part
   * flaps about, which reads as a hinge coming undone rather than as metal
   * taking a permanent set.
   */
  crumpleDampingAfter?: number;
}

export interface SceneNode {
  id: string;
  name: string;
  /**
   * Optional because the scene has always contained bodies without it: the STL
   * import and the MCP bridge build nodes straight, and nothing downstream —
   * the MJCF emitter included — reads it. It marks a body where something hands
   * back a mixed bag of objects (see AICopilotPanel).
   */
  type?: 'body';
  pos: number[];
  quat?: number[];
  euler?: number[];
  geoms: SceneGeom[];
  joints: SceneJoint[];
  children: SceneNode[];
  allowCoupling?: boolean;
  coupleTargetId?: string;
  coupleRatio?: number;
  weldTargetId?: string;
  connectTargetId?: string;
  connectAnchor?: number[];
  /**
   * What it takes to shear this body's weld off, in newtons.
   *
   * MuJoCo holds a weld with an equality constraint and reports the force it is
   * spending to do so, so "the handle snaps off when you load it hard enough"
   * is a threshold on a number the solver already computes. Six constraint rows
   * per weld: the first three are force in N, the last three torque in N*m.
   *
   * Undefined means the weld never lets go, which is what every weld did before
   * this existed. Breaking is a SIMULATION event and never touches the saved
   * scene: the document still says the handle is welded on, and Reset puts it
   * back. See utils/breakThresholds.ts for the decision itself.
   */
  weldBreakForceN?: number;
  /** The same, for the torque trying to twist the weld apart, in N*m. */
  weldBreakTorqueNm?: number;
  /**
   * How many consecutive steps the overload has to last before it counts.
   *
   * Not polish. A hard contact makes the solver spike for a single step as it
   * resolves the penetration, and a threshold read one step at a time snaps
   * welds that were never really loaded. Three steps is 3 ms and is enough to
   * tell a real load from a solver transient.
   */
  weldBreakHoldSteps?: number;
  /**
   * How hard this body has to be hit before it comes apart, in newton-seconds.
   *
   * IMPULSE rather than force, because contact force in a hard solver is a
   * spike whose height depends on the timestep as much as on the collision.
   * Momentum does not care: 0.2 kg arriving at 5 m/s and stopping dead is
   * 1 N*s, and that is a figure somebody can reason about.
   *
   * Undefined means it never shatters. Like a broken weld, shattering is a
   * SIMULATION event: the shards live in the store's runtime overlay and the
   * saved scene still holds the whole body, so Reset makes it whole again.
   */
  shatterImpulseNs?: number;
  /**
   * The material last picked in the sidebar's Deformation card, or 'custom'
   * once a number has been changed by hand. A label only: the shatter and
   * dent fields it wrote are what the physics reads. See utils/deformMaterials.ts.
   */
  deformMaterial?: string;
  /**
   * The wall thickness `shatterImpulseNs` is rated for, in metres.
   *
   * Set, and the threshold follows how thick the body is WHERE IT WAS HIT: a
   * wall half this thick breaks at half the blow, one twice as thick needs
   * twice it, within limits (see shatterLimit in utils/breakThresholds.ts). So
   * a wine glass struck on the bowl breaks where the same blow on its foot
   * would not. Unset, the threshold is the same everywhere. Brittle materials
   * set it; wood and plastic, which fail by splitting rather than by a flaw
   * opening, do not.
   */
  shatterThicknessRef?: number;
  /** How many pieces to break into. 2..24, default 8. See utils/fracture.ts. */
  shatterPieces?: number;
  /** Fixes which pieces, so a scene breaks the same way twice. */
  shatterSeed?: number;
  /**
   * 'radial' crowds the pieces toward the point of impact, which is both what
   * really happens and what reads as a blow rather than as a dissolve.
   */
  shatterPattern?: 'uniform' | 'radial';
  /** Extra outward speed given to each shard, m/s. Sells the burst. */
  shatterSpread?: number;
  /**
   * How many times over the pieces may break again.
   *
   * 0, the default, means a body shatters once and its shards are final. 1 lets
   * the shards break when they land, which is what really happens to porcelain
   * and looks it.
   *
   * Kept small deliberately. Every generation multiplies the body count —
   * fourteen pieces breaking into four each is fifty-six free bodies and their
   * contact pairs — and each break is a rebuild of the MuJoCo model, so a scene
   * set to cascade will hitch its way down. Two is the ceiling.
   */
  shatterDepth?: number;
  /**
   * Which generation this body is: absent or 0 for something authored, 1 for a
   * shard of it, and so on. Written by the shatter, never by hand.
   */
  shatterGeneration?: number;
  /**
   * For a shard: the body it came from, and that body's pose and velocity at
   * the instant it broke (MuJoCo Z-up, world frame). `pos`/`quat` and the free
   * joint's initialVelocity are only right for that instant. The model the
   * shard lives in is built some while later, and by then the broken body has
   * gone on moving in the old model, so the worker re-bases the shard onto
   * where `joint`'s body actually is when the build lands. Written by the
   * shatter, never by hand.
   */
  shatterFrom?: {
    joint: string;
    pos: [number, number, number];
    quat: [number, number, number, number];
    vel: [number, number, number];
    angvel: [number, number, number];
  };
  isWedge?: boolean;
  width?: number;
  depth?: number;
  height?: number;
  wedgeAngle?: number;
  isPyramid?: boolean;
  isCone?: boolean;
  isTorus?: boolean;
  isTube?: boolean;
  radius?: number;
  majorRadius?: number;
  tubeRadius?: number;
  innerRadius?: number;
  outerRadius?: number;
  isCurve?: boolean;
  curvePoints?: number[][]; // body-local Z-up control points; spline = rolling surface
  curveWidth?: number;
  curveThickness?: number;
  curveSegments?: number;
  curveClosed?: boolean; // wrap the spline into a seamless loop
  curveBank?: number; // bank (roll) angle in degrees; positive raises the left-of-travel edge
  isPulleyWheel?: boolean;
  leftTargetId?: string;
  rightTargetId?: string;
  pulleyRadius?: number;
  isPulleyRope?: boolean;
  pulleyWheelId?: string;
  isAerodynamic?: boolean;
  rot?: number[];
  /**
   * Tooth count of a generated gear. A gear is defined by this rather than by
   * its size, so the scale controls hide themselves when it is set: scaling one
   * gear would put it out of step with whatever it runs against.
   */
  teeth?: number;
  /**
   * The body's position before the current absolute-rotation gesture, so the
   * gesture composes from where it started instead of from its own last result.
   * Working state, like SceneGeom.baseVertices.
   */
  basePos?: number[];
  isHardwareComponent?: boolean;
  hardwareType?: string;
  hardwareSpec?: Record<string, number | string>;
  script?: string;
  scad?: string;
  // --- CSG (boolean modifiers) ---------------------------------------------
  // When true, the body's geoms are treated as a CSG program rather than as a
  // set of independent solids: positives are unioned, geoms marked
  // csg:'difference' are subtracted, csg:'intersection' geoms intersect. The
  // result is compiled to a mesh via OpenSCAD; see src/utils/csg.ts.
  csgEnabled?: boolean;
  // How the boolean result collides:
  //   'auto'       — decompose into convex angular sectors around the hole axis
  //                  when one can be found, else fall back to 'primitives'
  //   'decompose'  — force sector decomposition
  //   'primitives' — the positive source primitives are the colliders; the
  //                  boolean mesh is visual only (holes don't collide)
  //   'hull'       — the boolean mesh itself collides, i.e. as its convex hull
  //
  // @deprecated Superseded by `collision`, which says the same things for ANY
  // body with a mesh geom rather than only for a boolean one. Never written by
  // new code; read it through collisionModeOf() so old saves keep their
  // behaviour.
  csgCollision?: 'auto' | 'decompose' | 'primitives' | 'hull';
  csgSectors?: number;      // sector count for decomposition (default 16)
  csgFn?: number;           // OpenSCAD $fn for generated primitives (default 32)
  csgHoleAxis?: 'x' | 'y' | 'z' | 'auto'; // hole axis for decomposition
  csgMass?: number;         // total mass of the boolean solid, split across colliders
  // Set by the evaluator, read by the UI. csgHash fingerprints the inputs the
  // derived geoms were built from, so the auto-compiler knows when they're stale.
  csgHash?: string;
  csgScad?: string;         // the generated OpenSCAD source (read-only, for inspection)
  csgVolume?: number;       // true volume of the boolean solid (m³)
  csgHullVolume?: number;   // volume of its convex hull (m³) — the 'hull' mode figure
  csgCentroid?: number[];   // centroid offset applied to the compiled body frame
  csgWarning?: string;      // e.g. "no hole axis found, colliding as primitives"
  csgError?: string;
  /**
   * How this body's geometry is presented to MuJoCo for contact. Applies to any
   * body with a mesh geom, boolean or not — an imported STL, a sculpt, a lattice
   * part and a relief all reach MuJoCo as one mesh, and MuJoCo takes the convex
   * hull of every one of them. That is why a cup is solid to a ball.
   *
   *   'auto'       — decide from the mesh: convex enough, or too coarse or too
   *                  dense to be worth it, and it collides as its hull; concave,
   *                  and it is decomposed into convex pieces.
   *   'hull'       — one convex hull. MuJoCo's own behaviour; cavities fill in.
   *   'decompose'  — force decomposition even when 'auto' would decline.
   *   'primitives' — CSG only: the authored positives collide, mesh is visual.
   *
   * Absent means 'auto'. See utils/convexDecomposition.ts.
   */
  collision?: CollisionMode;
  /** Hull budget for a decomposition. Absent = derived from how concave it is. */
  collisionHulls?: number;
  /** Total mass split across the derived colliders, as csgMass is for a boolean. */
  collisionMass?: number;
  /**
   * Fingerprints the inputs the colliders on this node were built from, so the
   * auto-compiler knows when they are stale. The non-boolean counterpart of
   * csgHash; a boolean body uses csgHash and leaves this unset.
   */
  collisionHash?: string;
  /**
   * Whether the last decomposition actually produced colliders. Read by the
   * staleness check so it can tell "this body collides as a hull, correctly"
   * from "this body's colliders went missing" — which is what a share link does
   * on purpose, since the pieces are regenerable and the budget is 64 kB.
   */
  collisionDecomposed?: boolean;
  /**
   * True volume over convex-hull volume, as the last decomposition measured it.
   * 1 is convex; a cup is nearer 0.3. Shown in the panel because it is the whole
   * basis of the 'auto' decision, and a number a user can act on.
   */
  collisionSolidity?: number;
  collisionWarning?: string;
  collisionError?: string;
  /**
   * A free-form sculpted body: its mesh geom is not derived from parameters, so
   * nothing may regenerate it. The sculpt tools own it, and the primitive
   * sliders in the inspector have nothing to act on.
   */
  isSculpt?: boolean;
  /** Which base shape it was started from. See utils/sculptBases.ts. */
  sculptBase?: string;
  /**
   * Bumped whenever the mesh is replaced wholesale rather than edited — picking
   * a different base. The viewport keys its sculpting surface on this, so the
   * new mesh is loaded instead of the old one being carried on with.
   */
  sculptVersion?: number;
  /** Set once a stroke has landed, so switching base can warn before discarding it. */
  sculptEdited?: boolean;

  /**
   * A lattice body: built by connecting points on a grid rather than by
   * describing it or by brushing it. See utils/latticeMesh.ts.
   *
   * Its mesh geom holds the SUBDIVIDED result, which cannot be turned back into
   * the cage that produced it — so `latticeCage` is the real document and the
   * geom is output. Without the cage stored, a saved lattice would reopen as
   * something that can be looked at and never edited again.
   */
  isLattice?: boolean;
  latticeCage?: { unit: number; coords: number[]; faces: number[]; faceSizes: number[] };
  /** How many Catmull-Clark passes the mesh geom was built with (0, 1 or 2). */
  latticeSubdiv?: number;
  /**
   * Wall thickness in metres, or 0 for none. A lattice is drawn as a surface,
   * and a surface has no inside for a slicer or a CAM job to fill; this is what
   * turns one into a shell. Applied when the mesh is built, never to the cage,
   * so it can be changed or taken off without the shape remembering it.
   */
  latticeThickness?: number;
  /**
   * How far the mesh geom was shifted to put its centre of mass on the body
   * origin, in the body's own axes. Bodies rotate about their origin and MuJoCo
   * moves a mesh asset onto its own centre of mass, so a shape built off to one
   * side has to be recentred and the body moved to compensate; this is what was
   * compensated for last time, so the next commit can apply the difference.
   */
  latticeOrigin?: number[];
  /** Bumped when the cage is replaced wholesale, to remount the editor on it. */
  latticeVersion?: number;
  /**
   * The cage has been APPLIED: this body's mesh is now its own document, and
   * the lattice tools are closed on it for good.
   *
   * Sculpting is what asks for this. The two cannot both own the same mesh —
   * the cage regenerates it from scratch on every edit, so a sculpted lattice
   * body loses its sculpting the moment a face is moved, silently and much
   * later. So sculpting a lattice body bakes it: `isLattice` goes off, this
   * goes on, and the cage stays in the file. Undo puts all three back.
   */
  latticeBaked?: boolean;
  /** Set once a face has been drawn, so a reset can warn before discarding it. */
  latticeEdited?: boolean;
  isComposite?: boolean;
  compositeType?: 'cable' | 'grid' | 'rope' | 'cloth';
  compositeCount?: string;
  compositeSize?: string;
  compositePrefix?: string;
  compositeCurve?: string;
  weldLastToId?: string;
}

export interface SceneGraph {
  nodes: SceneNode[];
  /**
   * What to call the scene. Optional because nothing sets it on the live store
   * graph; a saved user preset carries one, and the export dialogs use it to
   * name the file they write.
   */
  name?: string;
}
