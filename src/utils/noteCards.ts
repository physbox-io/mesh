// Shared between App.tsx (UI preset dropdown) and useMCPBridge.ts (MCP LOAD_PRESET
// handler) so both paths produce the same note card for a given built-in preset
// instead of App.tsx's copy silently diverging from — or simply not being reachable
// from — the MCP bridge.
export const PRESET_NOTE_CARDS: Record<string, string> = {
  empty: `# Blank Scene\n\nAn empty world with just the ground plane.\n\n## Getting started\n- Drag components from the left sidebar into the scene\n- Select a body to edit its mass, size, and material\n- Press **Play** to start the simulation`,

  pendulum: `# Double Pendulum\n\nTwo rigid rods connected by **hinge joints**, exhibiting chaotic motion.\n\n## Physics\n- **Hinge joints** constrain each rod to 1-DOF rotation\n- Small changes in initial angle lead to wildly different trajectories — a hallmark of **deterministic chaos**\n- Energy is conserved (no damping by default)\n\n## Try it\n- Change the initial angle of either bob to see chaos emerge\n- Add joint damping to watch energy decay`,

  cubes: `# Stacked Cubes\n\nRigid-body stacking with contact forces and friction.\n\n## Physics\n- **Free joints** give each cube 6 degrees of freedom\n- Resting contact is resolved by the **constraint solver** (PGS)\n- Stack height is limited by friction and the solver's penetration tolerance\n\n## Try it\n- Reduce floor friction to watch the stack slide\n- Change cube masses to shift the centre of mass`,

  gears: `# Gear System\n\nTwo meshing spur gears coupled by **proximity-aware equality constraints**.\n\n## Physics\n- Direct gear-tooth collision causes jitter; instead, angular velocities are linked via a **joint equality constraint** when gears are within meshing distance\n- Gear ratio is determined by the ratio of tooth counts\n- Uncheck *Allow Mechanical Coupling* to test raw contact\n\n## Key settings\n- **Teeth count** controls gear ratio\n- **Damping** prevents runaway spin`,

  machine: `# Gear Train Machine\n\nA multi-stage gear train demonstrating **torque multiplication**.\n\n## Physics\n- Each meshing pair is proximity-coupled; a driving hinge torque propagates through the chain\n- Output speed = input speed × (product of driver teeth / product of driven teeth)\n- Larger driven gears turn slower but with more torque\n\n## Try it\n- Apply a control script torque to the first gear via \`api.applyJointForce()\`\n- Observe speed reduction at each stage`,

  rack_pinion: `# Rack and Pinion\n\nConverts **rotary motion** (pinion gear) to **linear motion** (rack).\n\n## Physics\n- Pinion hinge rotation is coupled to rack slide translation via a **joint equality constraint** when the bodies are within 0.5 m\n- Linear displacement = pinion angle × pinion pitch radius\n\n## Try it\n- Drive the pinion with a script: \`api.applyJointForce('pinion_hinge', 5)\`\n- Add a load mass to the rack to see force requirements increase`,

  inclined_plane: `# Inclined Plane\n\nClassic mechanics: a block sliding down a ramp under gravity.\n\n## Physics\n- Net force along the plane: *F = mg sin θ − μmg cos θ*\n- **Static friction** prevents motion when *tan θ < μ*\n- Once sliding, **kinetic friction** is lower than static\n\n## Try it\n- Adjust the wedge angle to find the critical slip angle\n- Change the block's friction coefficient in the properties panel`,
  oval_track: `# Oval Curve Track\n\nA marble circulating on a **banked oval** built from the Curve component — a closed Catmull-Rom spline decomposed into convex box segments.\n\n## Physics\n- **Banked turns**: the −18° bank tilts the contact normal inward, supplying centripetal force\n- Equilibrium speed: *v² = g·r·tan θ* — the marble is launched near this speed\n- Too fast → drifts up the bank; too slow → slides down it (self-correcting within the track width)\n\n## Try it\n- Select the track and **drag the blue control-point handles** to reshape the oval live\n- Adjust Bank Angle in the properties panel and watch the marble's line change\n- Increase the marble's **Launch Velocity** (joint panel) to see it climb the bank`,

  pulley_system: `# Atwood Machine

Two unequal weights on a rope over a single wheel — the classic demonstration that acceleration depends on the mass *difference* but inertia depends on the mass *sum*.

## Physics
- Left weight **2 kg**, right weight **1 kg**, joined by an inextensible rope
- Acceleration *a = g(m₁ − m₂)/(m₁ + m₂ + I/r²)* ≈ **3.1 m/s²**, well under free fall
- The rope constrains *x_left = −x_right*, and *x = r·θ* turns the wheel with it
- Travel limits stand in for the rope's length

## Key concepts
- Adding equal mass to *both* sides slows it down without changing the net force
- The wheel's own inertia *I/r²* adds to the system mass — a heavy pulley matters
- This is a single fixed wheel, so there is **no mechanical advantage** (MA = 1); lifting the load still takes its full weight

## Try it
- Even the masses up and watch it hold still
- Make the difference tiny (2.0 vs 1.9 kg) to slow the acceleration right down
- Increase the wheel's mass to see *I/r²* drag the acceleration below the ideal`,

  cartpole: `# Cartpole\n\nA cart-pole balancing system controlled by an **LQR controller**.\n\n## Physics\n- The cart slides on a frictionless track (slide joint)\n- The pole pivots on a hinge — an **inverted pendulum**, inherently unstable\n- A **Linear Quadratic Regulator (LQR)** applies horizontal force to keep the pole upright\n\n## Control law\n*F = −(k_x·x + k_v·ẋ + k_θ·θ + k_ω·θ̇)*\n\n| Gain | Value | Role |\n|------|-------|------|\n| k_x | 8.0 | Commanded lean from cart position |\n| k_θ | 40.0 | Vertical catch |\n\n## Try it\n- Increase the pole's mass to stress-test the controller\n- Modify gains in the control script`,

  newtons_cradle: `# Newton's Cradle\n\nConservation of **momentum and energy** in elastic collisions.\n\n## Physics\n- Each ball is a pendulum on a hinge joint\n- Collisions are nearly elastic (high restitution)\n- Momentum is transferred through the stationary balls — only the end ball swings out\n- *n* balls swung in → *n* balls swing out (momentum + energy conservation)\n\n## Try it\n- Pull back 2 balls instead of 1 and observe the output`,

  suspension_bridge: `# Suspension Bridge\n\nA cable-stayed bridge demonstrating **static equilibrium** and structural load paths.\n\n## Physics\n- The deck is supported by angled cables under tension\n- Load is transferred: deck → cables → towers → ground\n- Cables can only pull, not push (tension-only members)\n\n## Try it\n- Drop a heavy object onto the deck\n- Remove a cable to see redistribution of load`,

  paper_plane: `# Paper Plane\n\nAerodynamic flight with **lift, drag, and pitch stability**.\n\n## Physics\n- The plane is an **aerodynamic body** (isAerodynamic = true)\n- Lift: *L = ½ ρ v² C_L A sin(α)* where α is angle of attack\n- Drag: *D = ½ ρ v² C_D A*\n- Forces are applied each timestep via the control script\n\n## Key concepts\n- Too steep an angle of attack → stall (lift collapses)\n- Trim angle sets the glide ratio\n\n## Try it\n- Adjust launch velocity and angle in the joint initial velocity\n- Change wind speed in Environment settings`,

  monkey_head: `# Monkey Head\n\nA physics-active body built from **compound primitive geoms** — no mesh required.\n\n## Physics\n- A **free joint** gives the head full 6-DOF motion — it falls, bounces, and rolls\n- The shape is approximated by ~15 ellipsoids, spheres, and boxes (skull, snout, cheeks, eyes, ears…)\n- MuJoCo computes the **composite inertia tensor** automatically from all geoms\n- Collision is handled per-geom — each primitive has its own contact normal\n\n## Key concepts\n- Complex shapes are best approximated by multiple primitives, not a single mesh\n- Compound bodies share one free joint on the root geom\n\n## Try it\n- Increase restitution (bounciness) in the geom friction settings\n- Drop it from different heights via Launch Velocity`,

  golden_gate: `# Golden Gate Bridge (Primitive)\n\nA suspension bridge built from **primitive geoms** (boxes and capsules).\n\n## Physics\n- All structural members are static bodies (no joints = welded to world)\n- The bridge is a rigid visual reference — drop objects onto it!\n- Primitive collision hulls are exact for simple shapes\n\n## Try it\n- Add a free sphere above the deck and watch it roll off\n- Toggle solid/ephemeral collision on bridge members`,

  golden_gate_mesh: `# Golden Gate Bridge (Mesh)\n\nThe same bridge reconstructed with **custom mesh geoms**.\n\n## Physics\n- Deck, towers, and cables are static mesh bodies\n- Mesh collision uses MuJoCo's **convex hull** approximation\n- Concave shapes require decomposition into multiple convex pieces\n\n## Key concepts\n- Mesh vertices authored in Three.js Y-up; Y↔Z swap is automatic\n- Face winding must be outward-facing (CCW viewed from outside)`,

  mesh_collision: `# Mesh Collision Demo\n\nShows a **dynamic convex mesh** (pyramid) interacting with a static ramp.\n\n## Physics\n- The pyramid is a **dynamic mesh** (dynamic: true) with a free joint\n- MuJoCo takes the **convex hull** of the mesh for collision\n- renderVertices are in raw Z-up space for Three.js rendering alignment\n\n## Key concepts\n- Body position tracks the mesh's **volume centroid** (not the base)\n- Set body_pos.z to centroid height to sit flush with the ground`,

  coin_flip: `# Coin Flip\n\nA probabilistic physics experiment demonstrating **initial condition sensitivity**.\n\n## Physics\n- The coin has a free joint (6-DOF)\n- A control script randomises angular velocity at *t = 0* using \`api.setAngularVelocity()\`\n- Heads/tails outcome is determined by which face is up when it lands\n\n## Key concepts\n- Coin toss is deterministic given exact initial conditions\n- Randomness comes from the random seed applied in the script\n\n## Try it\n- Run headless 1000× via MCP to measure heads/tails ratio`,

  windmill: `# Wind Turbine (Aerodynamic)\n\nA three-blade turbine driven by **aerodynamic lift on the blades**.\n\n## Physics\n- Each blade is marked isAerodynamic = true\n- Lift is computed from relative wind velocity and angle of attack\n- The hub hinge converts blade lift torque to rotational speed\n- Wind is set globally via Environment → Wind X\n\n## Key equations\n*L = ½ ρ v_rel² C_L A sin(α)*\n*T = L × arm_length*\n\n## Try it\n- Increase wind speed to raise RPM\n- Change blade pitch angle to find optimal attack angle`,

  physics_only_windmill: `# Wind Turbine (No Aerodynamics)\n\nThe same turbine geometry driven by a **direct script torque** instead of aerodynamics.\n\n## Physics\n- Aerodynamic forces are disabled; a fixed torque is applied via control script\n- Useful for isolating mechanical behaviour from aerodynamic complexity\n- Hinge damping limits maximum RPM\n\n## Try it\n- Compare RPM with the aerodynamic version at the same wind speed\n- Vary damping to tune the speed`,

  traditional_windmill: `# Traditional Windmill (4-Blade)\n\nA classic four-sail Dutch windmill driven by wind pressure.\n\n## Physics\n- Four flat sails create drag-driven rotation (not lift-driven)\n- Each sail is an aerodynamic flat plate; drag dominates at low tip-speed ratios\n- The main shaft hinge connects sail rotation to a milling load\n\n## Try it\n- Adjust sail area (size) to change torque at a given wind speed`,

  drone: `# Quadcopter Drone\n\nA quadrotor UAV with **PD attitude control** and per-rotor thrust.\n\n## Physics\n- Four rotors apply upward thrust and reaction torques\n- **PD controller** compares current orientation to target and commands differential thrust\n- Aerodynamic drag is applied to the frame body\n\n## Control law\n*τ = k_p × error + k_d × error_rate*\n\n## Try it\n- Use arrow keys / WASD to command pitch and roll\n- Adjust k_p and k_d gains in the control script to tune stability\n- Increase rotor drag coefficient to simulate thicker air`,

  boolean_shapes: `# Boolean Cutouts

Four bodies whose shape comes from **subtracting** one primitive from another, dropped onto the floor.

## How they're built
None of these is a special shape type. Each body is just two or three ordinary geoms with one marked \`csg: 'difference'\`, compiled into a mesh by OpenSCAD. The **primitives stay the source of truth** — select a body and every size slider still reshapes it, then the mesh is regenerated.

| Body | Recipe |
|------|--------|
| Ring | ellipsoid − taller ellipsoid |
| Crescent | disc − *offset* disc |
| Hollow cube | cube − three square shafts |
| Chopped cone | cone − box above the cut |

## The physics catch
MuJoCo takes the **convex hull** of every mesh geom, so a hole would not exist for contact — a ring would collide as a solid disc. Each body picks a strategy:

- **Ring, crescent, hollow cube** — \`auto\`: the result is sliced into convex sectors around the hole axis, so the hole is *real*. At 20 sectors the colliders intrude only ~1.2% of the hole radius.
- **Chopped cone** — \`hull\`: not an approximation at all, because a frustum is *already convex*.

Only **one** of the hollow cube's three shafts collides (the Z one) — decomposition works about a single axis, so the other two are visual.

## Try it
- Select a body and drag the **negative shape** around — it's drawn as a red outline
- Switch a body's **Collision** mode to \`Convex hull\` and watch the hole stop working
- Drop a small sphere through the ring's hole while it lies flat`,

  bouncy_balls: `# Bouncy Balls\n\n20 multicolored spheres with **high restitution** colliding under gravity.\n\n## Physics\n- Each ball has a **free joint** (6-DOF) and a unique radius (0.18–0.27 m)\n- Uses MuJoCo's **spring-damper contact model**: \`solref=[timeconst, dampingRatio]\`\n- \`solref=[0.04, 0.2]\` = 40 ms contact spring, 20% damping → lively bounce\n- \`dampingRatio < 1\` = underdamped = bouncy; \`= 1\` = critically damped = no bounce\n\n## Try it\n- Use the **Bounciness slider** in the properties panel to tune each ball\n- Change gravity in Environment settings to see low-gravity chaos`,

  openscad_demo: `# OpenSCAD Showcase\n\nA tray whose shape is written as **code**, not dragged out of a palette.\n\n## How it works\n- The body's \`scad\` source is compiled by **openscad-wasm** into a triangle mesh\n- The mesh is drawn as-is, but MuJoCo collides any mesh as its **convex hull** — so the tray's walls are backed by five plain boxes that do the actual containing\n- Edit the source and it recompiles; the boxes stay where they are\n\n## Try it\n- Open the **SCAD editor** on the container and change a dimension\n- Drop a component in and watch it stay inside the walls, not the hull`,

  rope_bridge: `# Rope Bridge\n\nA **cable composite** — 25 linked capsules with a heavy ball dropped onto it.\n\n## Physics\n- MuJoCo expands the composite into a chain of bodies joined by ball joints, welded to the anchor at each end\n- The chain has no bending stiffness, so it hangs in a **catenary** and carries load purely in tension\n- The ball's weight is shared along the span; the shallower the sag, the higher the tension\n\n## Try it\n- Increase the ball's mass and watch the sag deepen\n- Move an anchor apart to pull the rope taut — tension climbs steeply as it straightens`,

  birdhouse: `# Birdhouse (Primitives)\n\nA 6-panel wooden birdhouse constructed out of primitive boxes and a CSG entrance cutout.\n\n## Laser Cutting\n- Designed for **laser cut face unwrapping**\n- Features interlocking **finger joints** or **glue edge** profiles\n- Front panel has a circular entrance hole cut via CSG boolean difference\n\n## Try it\n- Click **Export Laser Cut (SVG)** in the top toolbar to generate laser vector cut paths`,

  birdhouse_scad: `# Birdhouse (OpenSCAD)\n\nA 3D birdhouse model generated from OpenSCAD code.\n\n## Laser Cutting\n- Evaluates OpenSCAD polyhedral mesh into 2D coplanar panel clusters\n- Extracts boundary cutouts and finger joint edges\n\n## Try it\n- Click **Export Laser Cut (SVG)** in the top toolbar to view unwrapped 2D sheet layout`,

  mega_bust_studio: `# Mega Bust & Stress Studio

A **solver stress test** dressed as a sculpture studio: one dense mesh standing still while 30-odd loose bodies fall over around it.

## What is in the scene
| Piece | Bodies | What it is for |
|-------|--------|----------------|
| Classical bust | 1, fixed | 120 x 80 procedural lathe — about **19,000 triangles** |
| Wrecking pendulum | 2 | Hinged arm with a 0.8 kg bob, the heaviest single impact here |
| Collapse tower | 16 | 8 tiers of two blocks, each tier laid across the one below |
| Domino arc | 16 | A 270 degree arc; domino #1 starts leaning 15 degrees |

## Physics
- Every loose body carries a **free joint** (6-DOF), so this is roughly 34 free bodies and a hinge in one contact-rich scene — the interesting number is contacts per step, not bodies
- The bust has **no joint at all**: it is welded to the world and acts as the anvil everything else works against
- Its mesh geom collides as its **convex hull** — the nose and the undercut of the neck are visual only, so a domino resting against the chin touches the hull, not the face
- The pendulum stand is \`contype: 0, conaffinity: 0\` — it holds the arm up without ever taking part in a contact
- The hinge is damped at **0.0005**, low enough that the bob keeps swinging back through the wreckage

## Try it
- Press play and leave it: the leaning domino starts the cascade, which reaches the tower
- Watch the **step time** climb as the tower comes down — peak contact count, not body count, is what costs
- Raise the bob mass and drop it into the tower directly to skip the dominoes
- Turn the friction on the dominoes down and watch the cascade slide out instead of toppling`,

  california_relief: `# California Relief Map\n\nThe real state, at real proportions, built to be carved into a **150 mm square** block.\n\n## Geography\n- Projected in **EPSG:3310 "California Albers"** — the state's own official projection, so the outline is the shape California is actually drawn as, and equal area everywhere on the block\n- Terrain from open 1 km DEM tiles: **-82 m** at Badwater to **3,973 m** on the Sierra crest\n- Carves **104.0 × 120.0 mm** — 1 mm to about 8.8 km\n\n## Relief Carving\n- Height is exaggerated roughly **18×**; at true scale the Sierra would stand 0.5 mm proud and the board would read as flat\n- The lowest 15% of the depth is a plinth, so the coastline steps up from the background instead of fading into it\n- Set **Fit** to *manual, 100%* — fitting would rescale it to fill the stock and lose the 120 mm\n\n## Try it\n- Click **Export Relief Carve (G-code)**, rough with a 6.35 mm flat mill, finish with a 3.175 mm ball nose`,
};


/** The note card shown when a built-in preset is loaded, or null if it has none. */
export function makePresetNoteCard(presetKey: string): { id: string; markdown: string; minimized: boolean; x: number; y: number } | null {
  const md = PRESET_NOTE_CARDS[presetKey];
  if (!md) return null;
  return { id: `preset_note_${presetKey}`, markdown: md, minimized: false, x: 16, y: 16 };
}

export function computeNodeBoundingBox(node: any): { x: number; y: number; z: number } {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  const includeBounds = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (y0 < minY) minY = y0;
    if (y1 > maxY) maxY = y1;
    if (z0 < minZ) minZ = z0;
    if (z1 > maxZ) maxZ = z1;
  };

  if (node.width !== undefined || node.depth !== undefined || node.height !== undefined) {
    const w = node.width ?? 0.1;
    const d = node.depth ?? 0.1;
    const h = node.height ?? 0.1;
    includeBounds(-w / 2, w / 2, -d / 2, d / 2, -h / 2, h / 2);
  }

  if (node.radius !== undefined && node.height !== undefined) {
    const r = node.radius;
    const h = node.height;
    includeBounds(-r, r, -r, r, -h / 2, h / 2);
  }

  if (node.majorRadius !== undefined && node.tubeRadius !== undefined) {
    const R = node.majorRadius;
    const r = node.tubeRadius;
    includeBounds(-(R + r), R + r, -(R + r), R + r, -r, r);
  }

  if (Array.isArray(node.geoms)) {
    for (const g of node.geoms) {
      const gx = g.pos ? g.pos[0] : 0;
      const gy = g.pos ? g.pos[1] : 0;
      const gz = g.pos ? g.pos[2] : 0;

      const verts = g.renderVertices || g.vertices;
      if (Array.isArray(verts) && verts.length >= 3) {
        for (let i = 0; i < verts.length; i += 3) {
          const vx = verts[i] + gx;
          const vy = verts[i + 1] + gy;
          const vz = verts[i + 2] + gz;
          includeBounds(vx, vx, vy, vy, vz, vz);
        }
      } else if (g.fromto && g.fromto.length >= 6) {
        const [x1, y1, z1, x2, y2, z2] = g.fromto;
        const r = (g.size && g.size[0]) ? g.size[0] : 0.05;
        includeBounds(
          Math.min(x1, x2) - r + gx, Math.max(x1, x2) + r + gx,
          Math.min(y1, y2) - r + gy, Math.max(y1, y2) + r + gy,
          Math.min(z1, z2) - r + gz, Math.max(z1, z2) + r + gz
        );
      } else if (g.size && Array.isArray(g.size)) {
        let sx = 0.05, sy = 0.05, sz = 0.05;
        if (g.type === 'box') {
          sx = g.size[0] ?? 0.05;
          sy = g.size[1] ?? sx;
          sz = g.size[2] ?? sx;
        } else if (g.type === 'sphere') {
          sx = sy = sz = g.size[0] ?? 0.05;
        } else if (g.type === 'cylinder' || g.type === 'capsule') {
          sx = sy = g.size[0] ?? 0.05;
          sz = g.size[1] ?? sx;
        } else if (g.type === 'ellipsoid') {
          sx = g.size[0] ?? 0.05;
          sy = g.size[1] ?? sx;
          sz = g.size[2] ?? sx;
        } else {
          sx = g.size[0] ?? 0.05;
          sy = g.size[1] ?? sx;
          sz = g.size[2] ?? sx;
        }
        includeBounds(gx - sx, gx + sx, gy - sy, gy + sy, gz - sz, gz + sz);
      }
    }
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const cb = computeNodeBoundingBox(child);
      const cx = child.pos ? child.pos[0] : 0;
      const cy = child.pos ? child.pos[1] : 0;
      const cz = child.pos ? child.pos[2] : 0;
      includeBounds(cx - cb.x / 2, cx + cb.x / 2, cy - cb.y / 2, cy + cb.y / 2, cz - cb.z / 2, cz + cb.z / 2);
    }
  }

  if (minX === Infinity) {
    return { x: 0.1, y: 0.1, z: 0.1 };
  }

  const dx = Math.max(0.001, maxX - minX);
  const dy = Math.max(0.001, maxY - minY);
  const dz = Math.max(0.001, maxZ - minZ);

  return { x: dx, y: dy, z: dz };
}

export function formatComponentBoundingBoxes(nodes: any[]): string {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return 'No major components in scene.';
  }

  const majorNodes = nodes.filter(n => {
    const name = (n.name || n.id || '').toLowerCase();
    if (name === 'floor' || name === 'ground' || name === 'world') {
      if (n.geoms && n.geoms.some((g: any) => g.type === 'plane')) return false;
    }
    return true;
  });

  const targets = majorNodes.length > 0 ? majorNodes : nodes;

  const formatMm = (valM: number) => {
    const mm = valM * 1000;
    return mm >= 100 ? `${Math.round(mm)}mm` : `${mm.toFixed(1).replace(/\.0$/, '')}mm`;
  };

  const lines = targets.map(n => {
    const bbox = computeNodeBoundingBox(n);
    const displayName = n.name || n.id || 'Component';
    const dimStr = `${formatMm(bbox.x)} × ${formatMm(bbox.y)} × ${formatMm(bbox.z)}`;
    return `- **${displayName}**: ${dimStr}`;
  });

  return lines.join('\n');
}

export function extractTitle(assistantMarkdown?: string, userPrompt?: string, nodes?: any[]): string {
  // 1. Check primary node name from active scene nodes (excluding ground/floor/world)
  if (Array.isArray(nodes) && nodes.length > 0) {
    const primaryNode = nodes.find(n => {
      const nm = (n.name || n.id || '').toLowerCase();
      return nm !== 'floor' && nm !== 'ground' && nm !== 'world';
    });
    if (primaryNode) {
      const name = primaryNode.name || primaryNode.id;
      if (name && name.length <= 40 && !/^(node_\d+|body_\d+)/i.test(name)) {
        return name.charAt(0).toUpperCase() + name.slice(1);
      }
    }
  }

  // 2. Check assistant Markdown header
  if (assistantMarkdown) {
    const firstLine = assistantMarkdown.split('\n')[0]?.trim();
    if (firstLine && firstLine.startsWith('# ')) {
      const extracted = firstLine.substring(2).trim();
      if (extracted && !/^(Generated|MCP|Physics|Scene Summary|What is this|Explain|Diagnostics)/i.test(extracted)) {
        return extracted;
      }
    }
  }

  // 3. Check user prompt if it's not a generic query
  if (userPrompt) {
    const clean = userPrompt
      .replace(/^🪄\s*Generate\s*Scene:\s*/i, '')
      .replace(/^🛠️\s*Mutate\s*Scene:\s*/i, '')
      .replace(/^⚡\s*/i, '')
      .replace(/^🖨️\s*/i, '')
      .trim();
    
    const isQuestion = /^(what|how|why|explain|is|can|run|diagnose|tell|does)\b/i.test(clean) || clean.endsWith('?');
    if (!isQuestion && clean.length > 0 && clean.length <= 40) {
      return clean.charAt(0).toUpperCase() + clean.slice(1);
    }
  }

  return 'Physics Scene';
}

export function extractConciseSummary(assistantMarkdown?: string, userPrompt?: string): string {
  if (assistantMarkdown) {
    let cleanText = assistantMarkdown
      .replace(/```[\s\S]*?```/g, '')
      .replace(/^\|[\s\S]*?\|$/gm, '')
      .replace(/\|.*\|/g, '')
      .replace(/---+/g, '')
      .replace(/modeled using a combined OpenSCAD procedural CSG definition and a MuJoCo [a-z]+ collision hull\.?/gi, '')
      .replace(/using a combined OpenSCAD procedural CSG definition\.?/gi, '')
      .replace(/MuJoCo [a-z]+ collision hull\.?/gi, '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'))
      .join(' ')
      .replace(/\s+/g, ' ');
    
    if (cleanText.length > 0) {
      const sentences = cleanText.match(/[^.!?]+[.!?]+/g);
      if (sentences && sentences.length > 0) {
        return sentences.slice(0, 2).join(' ').trim();
      }
      return cleanText.length > 180 ? cleanText.substring(0, 180) + '...' : cleanText;
    }
  }

  if (userPrompt) {
    const cleanPrompt = userPrompt
      .replace(/^🪄\s*Generate\s*Scene:\s*/i, '')
      .replace(/^🛠️\s*Mutate\s*Scene:\s*/i, '')
      .trim();
    if (!/^(what|explain|how|diagnose)\b/i.test(cleanPrompt)) {
      return `Physics scene configured for: ${cleanPrompt.length > 100 ? cleanPrompt.substring(0, 100) + '...' : cleanPrompt}`;
    }
  }

  return 'Interactive 3D rigid-body physics scene.';
}

export function extractCustomSections(assistantMarkdown?: string): string {
  if (!assistantMarkdown) return '';
  // Extract custom Markdown sections (e.g. ## Physics, ## Design Decisions, ## Component Details, ## Try it)
  // excluding ## Component Bounding Boxes or ## Latest Summary
  const lines = assistantMarkdown.split('\n');
  const customLines: string[] = [];
  let capturing = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const sectionName = line.substring(3).trim();
      if (/^(Component Bounding Boxes|Latest Summary)/i.test(sectionName)) {
        capturing = false;
      } else {
        capturing = true;
        customLines.push(line);
      }
    } else if (capturing) {
      if (line.startsWith('# ') && !line.startsWith('## ')) {
        capturing = false;
      } else {
        customLines.push(line);
      }
    }
  }

  return customLines.join('\n').trim();
}

export function updateOrCreateNotecard(options: {
  mode: 'generate' | 'explain' | 'mutate' | 'mcp';
  userPrompt?: string;
  assistantMarkdown?: string;
  nodes?: any[];
}) {
  const getter = (window as any)._physics_getNoteCards;
  const setter = (window as any)._physics_setNoteCards;
  if (!setter) return;

  const currentCards: { id: string; markdown: string; minimized: boolean; x: number; y: number }[] = getter ? getter() : [];

  let nodeArray: any[] = (options.nodes && options.nodes.length > 0)
    ? options.nodes
    : ((window as any)._physics_store?.getState ? (window as any)._physics_store.getState().sceneGraph?.nodes || [] : []);

  const title = extractTitle(options.assistantMarkdown, options.userPrompt, nodeArray);
  // An 'mcp' call is a programmatic scene edit, not a conversation turn: its
  // userPrompt (when a caller passes one at all) is an internal command label
  // like "MCP UPDATE_OBJECT (pentacle_pendant)", never something a human wrote.
  // Feeding that to extractConciseSummary turns it into prose on the card
  // ("Physics scene configured for: MCP UPDATE_OBJECT (...)"), which describes
  // the plumbing rather than the scene. An MCP caller that wants to say
  // something about the scene passes assistantMarkdown, or writes the card
  // itself via SET_NOTE_CARDS.
  const summaryText = extractConciseSummary(
    options.assistantMarkdown,
    options.mode === 'mcp' ? undefined : options.userPrompt
  );
  const bboxMarkdown = formatComponentBoundingBoxes(nodeArray);
  const customSections = extractCustomSections(options.assistantMarkdown);

  if (currentCards.length > 0) {
    const existingCard = currentCards[0];
    const existingMd = existingCard.markdown || '';

    // Check if the existing card is a "Blank Scene" or getting started placeholder
    const isBlankCard = /#\s*Blank\s+Scene/i.test(existingMd) || /An\s+empty\s+world/i.test(existingMd) || /Drag\s+components/i.test(existingMd);

    // 'mcp' used to be lumped in here, which made every programmatic edit -
    // including a one-geom tweak via UPDATE_OBJECT - discard the card's whole
    // body (Design Decisions, Physics, Printability, anything the LLM or user
    // had written) and rebuild it from the auto-derived title/summary alone.
    // It also silently clobbered the card LOAD_PRESET had just installed. MCP
    // edits now take the preserving path below, which keeps existing prose and
    // refreshes only the derived Component Bounding Boxes; a caller that really
    // does want to rewrite the card has SET_NOTE_CARDS for that.
    if (options.mode === 'generate' || isBlankCard) {
      // Completely replace stale preset / Blank Scene card with the new scene title & summary!
      const contentMiddle = customSections ? `${summaryText}\n\n${customSections}` : summaryText;
      const updatedMd = `# ${title}\n\n${contentMiddle}\n\n## Component Bounding Boxes\n${bboxMarkdown}`.trim();

      const updatedCards = [
        { ...existingCard, markdown: updatedMd },
        ...currentCards.slice(1)
      ];
      setter(updatedCards);
      return;
    }

    // For Mutate or Explain on an active custom card:
    let cardTitle = title;
    const firstLine = existingMd.split('\n')[0]?.trim();
    if (firstLine && firstLine.startsWith('# ')) {
      const existingTitle = firstLine.substring(2).trim();
      if (existingTitle && !/^(Blank Scene|What is this)/i.test(existingTitle)) {
        cardTitle = existingTitle;
      }
    }

    const bboxIdx = existingMd.search(/##\s+Component\s+Bounding\s+Boxes/i);
    let baseSections = '';
    if (bboxIdx !== -1) {
      const parts = existingMd.substring(0, bboxIdx).split('\n\n');
      if (parts.length > 1 && parts[0].startsWith('# ')) {
        baseSections = parts.slice(1).join('\n\n').trim();
      }
    } else {
      const parts = existingMd.split('\n\n');
      if (parts.length > 1 && parts[0].startsWith('# ')) {
        baseSections = parts.slice(1).join('\n\n').trim();
      }
    }

    const sectionsToInclude = customSections || baseSections || summaryText;
    const updatedMd = `# ${cardTitle}\n\n${sectionsToInclude}\n\n## Component Bounding Boxes\n${bboxMarkdown}`.trim();

    const updatedCards = [
      { ...existingCard, markdown: updatedMd },
      ...currentCards.slice(1)
    ];
    setter(updatedCards);
  } else {
    // Create a new notecard if none exists!
    const contentMiddle = customSections ? `${summaryText}\n\n${customSections}` : summaryText;
    const newCard = {
      id: `note_card_${Date.now()}`,
      markdown: `# ${title}\n\n${contentMiddle}\n\n## Component Bounding Boxes\n${bboxMarkdown}`,
      minimized: false,
      x: 16,
      y: 16
    };
    setter([newCard]);
  }
}


