# Joint blobs and member fracture

**Status, 2026-10-26: built.** The current reference is GUIDE.md § 4c. The design changed in
these places once it ran:

- **Two pieces per member, not three.** The mid-span weld sits where bending peaks for any load
  between the supports, and where a column buckles. The ends are covered by the joint's weld,
  which takes the lower of the joint's limit and the member's.
- **Putty is a pin from the start, not a weld that yields.** Rigid joints that all gave way
  together when breaking was switched on shook a tower down that stood on pins. The blob gets
  slide joints instead of a free one: free, the blobs spun up and walked the tower apart like
  wheels. Rods on pins get rolling friction, or they act as rollers under a load.
- **Ductile members** use a ball joint whose friction is the yield moment, held by a lock weld
  that buckling or yield releases.
- **Bars are judged by which way they are bent:** the moment is split across the section's
  weak and strong axes.
- **Found along the way:** a weld's angular rows read twice the torque. That is fixed for every
  weld, and the Shatter bracket's crumple limit halved (6 → 3) so that scene is unchanged.
  Also: light parts need `boundinertia`, and the weld time constant is now 2 ms, MuJoCo's
  floor at a 1 ms step.
- **MCP needed docs only**, no new tool. The Pipes dialog builds frames of
  thin stock (pasta, 3 mm dowel) as free struts with blobs at the joints (`utils/gluedFrame.ts`).

Two general features. The spaghetti tower is their first demo, not their shape:

1. **Members break under load, whatever they are made of.** Any slender body (spaghetti, dowel,
   glass rod, steel tube, printed strut) bends, snaps, pulls apart or buckles at loads worked out
   from its material and its cross-section. `deformMaterials.ts` today covers *impacts* only
   (shatter, dent); this adds *static strength* to the same materials table.
2. **A joint material.** A resizable blob from the sidebar (putty, hot glue, marshmallow, PVA,
   epoxy, solder) that, at compile time, welds every part that ends inside it. How strong it is
   and how it fails come from its material and its size.

## Stability test (2026-10-26) — passed

The script was a scratch file, `tower.mjs` (session scratchpad). It used raw MJCF and real MuJoCo
3.17 in Node, with no app code. The tower is triangular, 100 mm sides, 4 × 100 mm levels:
**39 free spaghetti struts** (1.8 mm, 1450 kg/m³) and 15 free putty blobs (10 mm, 1800 kg/m³).
Nothing is fixed; the only things holding it up are the 78 welds, strut end to blob. Struts were
run whole (54 bodies) and in two pieces each (93 bodies, plus 39 welds at mid-span).

| Setting | Load on top | Sag | Jitter, last second | Notes |
| --- | --- | --- | --- | --- |
| MuJoCo default weld | 0 | **339 mm** | — | folds into a heap |
| `weldRigid` solref/solimp, default contact | 0 / 1 kg | 2.2 / 19 mm | 0 / 4 mm/s | sag is blobs **sinking into the floor** |
| absolute stiffness (`solref="-k -b"`) | 1 kg | 0.4 mm | **160–335 mm/s** | light parts buzz; rejected |
| `solref 0.004 1`, `solimp 0.999 0.9999 0.001`, **welds and every geom's contact** | 0.2 / 1 kg | 0.24 / 0.43 mm | 11–16 mm/s | whole struts |
| same, two pieces per strut | 1 kg | 0.66 mm | 0.6 mm/s | **chosen** |

- No NaNs or MuJoCo warnings in any run, including collapses with 60+ welds breaking and pieces
  falling.
- Speed: 1.1–1.6× realtime single-threaded in Node with 93 bodies, about 1.6× with 54.
- Breaking, with glue at 2 N pull-out and 5 N·mm twist and strut mid-welds at 11 N·mm (dry pasta,
  σ ≈ 20 MPa): with the load ramped in over 2 s, the tower failed at the same load, **≈0.5 kg**,
  whether the target was 0.6, 1.2 or 3 kg. So failure depends on load, not on solver noise. At
  rest the welds carry under 1% of their limits, so nothing breaks by accident.

What the test found, and the plan has to respect:

- **MuJoCo sets constraint softness relative to the mass of the bodies involved.** A 1 g part
  carrying a 1 kg load sinks into whatever it rests on, and its welds stretch. The fix is
  impedance close to 1 (`solimp 0.999 0.9999 …`), on the welds **and on the contact geoms of
  both bodies**, because MuJoCo averages `solimp` across a contact pair. Setting it on the floor
  alone did nothing. Absolute stiffness is not the fix: it makes light parts buzz.
- **A full load applied at t = 0 snaps everything within 14 ms.** The 3-step hold
  (`DEFAULT_HOLD_STEPS`) is not long enough for the start-up transient. Ramped in, the same load
  failed at its real limit.
- **A perfectly straight column never buckles in simulation.** Under 1 kg the mid-span bending in
  the posts stayed at about 1 N·mm. A real 100 mm spaghetti post buckles at about 1.8 N
  (Euler: π²EI/L²). So buckling has to be its own limit, on axial compression.
- With two or more pieces per strut, the residual jitter disappears.

## Design

### 1. Material strength (`utils/deformMaterials.ts`)

Add to every `DeformMaterial` a `strength` block: flexural strength σ (MPa), tensile strength
(MPa), Young's modulus E (GPa). Add the new materials the demos need (`pasta`, maybe `balsa`),
and density with them. The file stays pure and store-free.

### 2. Member fracture: one general mechanism

This applies to any body made breakable whose shape is a slender prism: a cylinder, capsule,
box or `fromto` geom with length over cross-section ≥ ~8. A new pure module,
`utils/memberFracture.ts`, splits it **at compile time** into N pieces (default 3: the break
shows where it happened). The scene graph keeps the one body, just as shatter keeps the whole
body. The pieces are joined by breakable welds whose limits come from the section:

- bending: `M = σ_flex · S` (S = πd³/32 for a rod; the box and tube forms too)
- tension: `F = σ_tensile · A`
- **buckling**: `P = π²·E·I / L²` on the member's *whole* length. This needs a
  signed, along-the-member force check in `breakThresholds.ts`, which only knows force
  magnitude today. So: add an axial-compression limit beside `weldBreakForceN`.

The pieces' own masses and inertias come from the geom's volume (no change there). The welds
use the stiffness settings from the test. A broken member stays broken until Reset, as welds and
shatter already do.

### 3. Joint blobs

- A palette tile **Joint** (or **Glue**) in `ComponentPalette.tsx` makes a body with an
  ellipsoid geom and `joinMaterial: 'putty' | 'hotGlue' | 'marshmallow' | 'pva' | 'epoxy' |
  'solder'` (a small table, `utils/joinMaterials.ts`). Resize it with the ellipsoid's existing
  size handles.
- Compile time (`mjcf.ts`): every *other* body with a geom whose end lies inside the blob gets
  welded to the blob. A body ends in two blobs, so this is a **list of welds per blob**. It must
  not go through `SceneNode.weldTargetId`, which holds a single weld.
- Strength scales with the blob: how much of the member it surrounds × the material's shear
  strength gives pull-out force, and the blob's size gives twist strength.
- How it fails depends on the material. Glue, epoxy and solder are stiff and then snap: a
  breakable weld. Putty and marshmallow **yield and stay bent**: past the yield torque, the joint
  turns damped instead of letting go. That is `crumple`'s behaviour applied to a weld, rather than
  a soft `solref`, which would sag according to the parts' masses instead of the putty.
- Collision filtering: give everything a blob joins (and a member's own pieces) an `<exclude>`
  pair, so overlapping ends at a joint do not push each other apart. Other parts keep colliding,
  so a falling tower lands on itself.

### 4. Solver settings that go with it (`mjcf.ts`)

- Emit the welds and the contacts of joined or fractured bodies with the impedance close to 1
  from the test (on the bodies, not the floor alone).
- Break detection does not start until the scene has **settled** (about 0.25 s, or until kinetic
  energy has stopped falling). Until then, overloads are not counted. This also helps every
  existing breakable weld.

### 5. Pipes

Spaghetti and dowel stock from the Pipes dialog come out as free members with fracture on,
joined by blobs at the nodes (material picked in the dialog: putty, glue, marshmallow). PVC/EMT
frames keep their printed fittings.

### 6. MCP and docs

- `physics_add_object` gains the join blob. `physics_update_object` sets `joinMaterial` and the
  member-fracture settings.
- `physics_get_breaks` reports each broken piece with what broke it (bending, tension, buckling,
  joint pull-out).
- The usual six-step sync across `mcp-docs.json`, the physbox-mcp fallback, `useMCPBridge.ts` and
  `systemInstructions.txt`, plus a release.

### 7. Presets

Two: **Spaghetti tower** (the triangle from the test with a marshmallow on top) and **Spaghetti
bridge** (a Pratt truss over a gap with a cup of coins hanging from it). Both need a shelf in
`PRESET_SHELF`.

## Tests

- `tests/memberFracture.test.ts`: section limits against hand calculations for a rod, a tube and a
  box. A 100 mm pasta rod with a load at mid-span breaks at its calculated bending load (±10%), and
  a post buckles at its Euler load.
- `tests/joinBlobs.test.ts`: the test tower built through `compileToMJCF`. It stands with
  sag < 1 mm and jitter < 2 mm/s. A ramped load fails at the load the limits predict, with no
  break before 0.25 s. Putty yields and stays bent while glue snaps.
- Glass, steel and wood members behave sensibly: a glass rod snaps at a lower deflection than a
  steel one of the same size, which yields first.

## Open questions

- How many pieces to split each member into: always 3, or by length?
- Should steel and other soft metals bend permanently (crumple-style mid-joints) instead of
  breaking? This plan says yes for `softMetal` and `steel`. Spaghetti, glass and stone snap.
