# Cloth: garment builder rebuild — handoff (updated 2026-11-03, session 2)

Worktree `/home/boab/mesh-cloth-spike`, branch `spike/cloth-sim`. **Everything since
8ee0ebb is uncommitted, by the user's choice: no commits and no MCP changes until they
say it's ready.** Dev server: port 5186 (`npx vite --config vite.worktree.config.ts`).

## The design (in place, working)

A garment is a surface standing off the parts of the form it covers by its ease, cut
open, cut at seams, flattened. The builder knows no kind of garment:

- `garmentPlan.ts` — **a garment as data**: `covers` (parts + stand-off: flare by
  height, taper along a limb, the skin's `hangFrom`/`downTo`, a `web` between an arm
  and the body for a batwing), `cuts` (neckline, hem with train, waist, limbEnd/Start,
  armhole, frontOpening) and `seams` (frontBack, centre, partBoundary = armhole,
  alongLimb = underarm, limbRing = a tube cut round at a bent joint, roundLimb, gores,
  dart). `garmentPlan(draft, form, layer)` reads the draft's *properties* — `top`
  ('neck' | 'waist'), `legs`, `over`, `sleeve`, `armhole`, `fitted`, `opening` — never
  the kind. `GARMENT_DEFAULTS` (garments.ts) are presets of those properties.
- `garmentShell.ts` — interprets the plan: SDF grid per part, blended ease field,
  surface net, cuts, floor laying, seams, heal, panels named by the cover's `names`.
- `garmentSurface.ts` — mesh ops. New: `healFlatTriangles` (T-junction flaps, which
  broke the flattener), `splitAlong`'s `where` now gets the triangle's corners.
- `garmentFlatten.ts` — LSCM + ARAP; the CG is now Jacobi-preconditioned (it had not
  been converging on panels of several thousand triangles: folded layouts).
- `formSdf.ts`, `surfaceNets.ts`, `formLimbs.ts`, `limbPath.ts` (now exposes `bend`),
  `bodyForm.ts` `formSkin` — unchanged in role.

Rules that came out of the bugs, all generic:
- A seam bounded by a part (`on`) runs through every triangle with a corner on the
  part and is trimmed back to edges whose midpoint is on it; the part-boundary seams
  (armholes) are cut first, so the side and underarm seams end exactly on them.
- The front/back seam is a blend of each part's own front plane (the body's centre
  plane; along an arm the vertical plane through its line, oriented by the arm's
  side), weighted by nearness like the ease. One plane left a forward-bent forearm a
  closed tube.
- A tube past a joint bent over 30° is cut round at the joint (`limbRing`): sleeves
  past the elbow are Upper/Lower; a sock is four gores. A lengthwise two-piece sleeve
  (`alongLimb.over`) stays available as a primitive but flattened at 10%.
- A batwing is a `web` part (a thin sheet from the arm's underside to the body's
  side, `depth` = `armhole`), stopped at the elbow; the old ease bulge was a saddle.
- A front opening narrower than ~0.6 grid cells is widened to that (bridges otherwise).

## Pieces, patterns, looks (this session, for the user's UI asks)

- `clothModel.ts` groups carry `material` and `flat` (uv, outline, strain95);
  `FlexInfo` carries them to the viewport (`physicsWorkerProtocol.ts`).
- `components/inspector/GarmentCard.tsx` (Main tab, cloth nodes with a garment):
  pieces drawn inline, sizes + strain, **Download pattern (SVG)** (`patternSvg.ts`,
  mm, grain lines, no seam allowance), and a **Worn / Pieces** toggle.
- `ClothSpec.layout: 'worn' | 'pieces'` — pieces: each panel its own particles laid
  flat 18 cm off its place, facing where it goes; shared shell points become stitches
  that close over the sew time; the solver's existing weightless-while-sewing path.
  Tested: t-shirt sews up to 4 mm clearance, 2% strain (`garments.test.ts`).
- `ClothLayer.tsx`: `MeshPhysicalMaterial` per fabric (leather/taffeta shine, velvet
  sheen). Jacket has `opening: 0.02` (front opens; panels frontL/frontR).
- Worker fills the shared `flexvert_xpos` at creation, and `ClothPiece` asks for a
  frame after its first fill (on demand, the frame after a rebuild drew the new
  geometry empty and nothing asked for another: garments vanished until a pointer event).
- Cloth is drawn as a slab the sim's 4 mm thickness (offset faces + walls on open edges).
- **Trims** (`GarmentDraft.trims`): `{ kind: stud|button|bead|zipper, along: <line>, spacing, size, rgba }`.
  Lines are the shell's named open edges (`GarmentShell.edges`: neckline, hem, waist,
  cuffL/R, armholeL/R, top, end) and seam names; `cuff` matches both cuffs. The
  jacket's `opening` is an **open seam** (`seams[].open`): cut exactly along x = 0 on
  the front, and `clothModel` gives the second panel its own unsewn copies of its
  points (a strip cut was straddled by triangles and never opened). Trims ride on
  particles (`ClothRenderGroup.trims` → `FlexInfo.trims`), drawn as instanced
  cones/discs/spheres/boxes along the normal in `ClothLayer`, and are marked on the
  pattern pieces (`FlatPattern.marks`, circles in the SVG and the card). Jacket preset:
  zipper on the opening, studs round the neckline and cuffs. Test: `garments.test.ts` 'trims'.

## Measured state (`tests/_probe.test.ts`, flatten strain95 per panel)

t-shirt 1.5/1.5/2.8/2.9 · dress 4.9/2.2 · dress+sleeves 4.9/2.3/2.4/2.4 · skirt 1.1 ·
jeans 3–4 · jacket 1.2/1.1, sleeves 4.0–4.3 · gown 7.5/7.3 · sock 4.6–7.5 · hat 2–4.

`garments.test.ts` modelling: 13/15 pass. Failing, both on the 5% bound:
1. **fuller female dress** front 6.1% — concentrated at the bust-dart tips (a slit's
   end). Likely wants the dart to end short of the bust point or a second dart.
2. **gown** 7.3–7.5% — residual at the web/arm junction and cuff. Was 275%.
Don't loosen the bound without a measurement; both are honest residuals.

## Still to do

- Drape suite (`garments.test.ts` drape cases, `cloth.test.ts`): run started this
  session; results in the final report. Presets on 5186 looked right for menswear.
- Trims are visual (the user: accuracy of the end picture and its panels matters, not
  the sim): no mass, no stiffness, no zipper closing. A zipper pull/tape, buttonholes,
  patches/appliqué (`kind: 'patch'` with a shape on a panel) are the obvious next trims.
- Pieces mode on an A-posed form with bent elbows and layers (menswear): sews up, but
  a few particles snag on the forearms (p99 strain 27%). A wrap arrangement round limbs,
  or straightening the arms to sew, would fix it. Single garments sew cleanly.
- Delete `tests/_probe.test.ts` or fold it in before merging; MCP docs for `layout`,
  `opening`, `top`, `legs` when the user says the branch is ready.

## Session 3 (2026-11-04) — drape tests, honest state

Suite (`garments.test.ts` + `cloth.test.ts`): **36 pass, 8 fail.** No baseline ever had the
drape tests passing (at 8ee0ebb the older suite failed 4 of 8 too).

Kept (verified): collider SDF sign by flood (`clothColliders.buildSdf`; a sock started
inside the toe), `FOOT_ROOM` under the feet, the limb fillet now a true tangent arc
(`limbPath.ts`; the old one dropped every foot 1.7 cm), ankle fillet 0.08S, shell grid
`H` sized to the thinnest covered limb (`garmentShell.ts`), snug `waistEase` for
garments from a waistband (`garmentPlan.snug`). Reverted (unvalidated): Jacobi-Chebyshev
stretch, collide-first ordering, gravity ramp.

Failing, with cause where known:
1. Trousers slide off the form (jeans 30 mm/s, menswear layers). Reproduced on a bare
   weighted ring on an 8° cone with μ 0.7: iteration count makes no difference (16/32/64
   identical), the per-substep contact push is ~0.8 mm (friction capacity ≫ slide), yet
   it slides ~3 mm/s. So the friction model (contact normal or its application in the
   velocity update, `xpbd.ts` end of `substep`) is wrong somewhere — next thing to find.
2. Regressions from the grid change to chase: dress-with-sleeves lost its back panel
   (front/back merged); jacket has a tiny `frontR` (0.0%) and the trims test sees the
   zipper on `back`+`frontL` — the opening seam/panel naming shifted with the finer grid.
3. Residual flatten strain: fuller dress front 6.1%, gown 6–7%, sock gore1 8.08% (bound 8%).
4. Leg warmer drape p99 10.2% (bound 8%).

## Session 4 (2026-11-06) — a more lifelike form

`formHead.ts` (head as blended masses, one radial contour per height), `formMuscles.ts`
(relief on torso, arm, leg). Elbow at 55% of the arm, default arms 0.55/0.505 m, deliberately
under anthropometric figures (0.61) because the user read those as too long; hands 0.168 S.
Torso rows blend over limb roots (`blendLimbRoots`), skin neck follows the head's
(`neckAxisY`), legs tuck under the skin above the crotch (`legTuck`). A thin line remains
at the top of the thigh; the user accepted the form as it stands.

## Session 5 (2026-11-07) — audit of Gemini's pass, and the generic rework

Gemini's uncommitted pass (elastics, prints, pockets/belt/loops, buttons, negative ease,
stretch fabrics, a `belt` kind) was audited and reworked. What stands now:

- **Draft planes** (`GarmentDraft.cuts`, `.seams`, type `GarmentPlane`): a plane, a mask
  (`on` parts, `front`, `z`, `x`), `mirror` for an L/R pair; seams can be `open`. Princess
  lines, yokes, a centre-back zip, a one-shoulder or backless cut are all data. The
  plan's built-in darts skip where a draft seam already runs (`seamedNear`); `darts: false`
  turns them off. Panels are named generically: duplicates by side (L/R, the one across
  the middle keeps the name), still-alike numbered from the centre out.
- **`top`: 'neck' | 'waist' | height (m)** — a band at any height (strapless). Replaces
  Gemini's overloaded `from` and its length-based magic (`length < 0.1`, the auto band at
  65% of a limb). The `belt` kind is gone (one belt: the add-on).
- **Gores** were a no-op in the shell since 8ee0ebb; now plane seams, from a waist seam on
  anything that reaches above the waist. The gown no longer asks for them (its batwing webs
  reach the waist seam: bodice 8–9%); without, gown flattens 3.2/4.9%.
- **Boning** (`GarmentDraft.rods`, `clothRods.ts`): rods along any named line, `z` range,
  kinds with EI and weight; straight at rest (a closed hoop rests round); links held at the
  channel's cut length, curvature |a+c-2b| -> 0 with compliance h^3/EI. Channels drawn on
  the pattern (`FlatPattern.lines`, dashed in SVG and card). Measured: a hoop keeps a jersey
  skirt at 96% of its radius vs 81% bare. A boned strapless bodice settles no differently
  from an unboned one in 2 s (neither falls; see the friction note in session 3).
- **Add-ons** (`garmentAddOns.ts`) are cloth, not decals: meshed flat, weighed, constrained,
  held by two-way tacks (`ClothTack.lift`: held from sliding and sinking, free to lift).
  Pockets go on a named panel at a fraction of its flat piece (`{ panel, at }`, mirrored
  on R), so any panel; loops are patches on the panel under the belt line; the belt is a
  strip cut `ratio` short along a line (into the garment from it, so a hatband sits above
  the brim) or round a height (each loop on the body; both ankles below it), and the cloth
  under it may gather to its length (`edgeMin`, as Gemini's elastics). Measured: the belt
  takes jeans in 0.45% (the cloth round it holds it out). Pieces mode keeps pockets and
  loops, sewn to the flat pieces; the belt only when worn.
- **Buttons**: the lapping front by the panel's side and `trim.lap` (default right), not
  a name suffix; a **button stand** strip (`trim.stand`, default 2.2 buttons) sewn to the
  lapping front's edge, tacked over the other front when fastened, holes and buttons down
  its middle. `stand: 0` keeps edge-to-edge.
- Also: `stiffnessScale` (and a piece's own `material`) now reach the solver
  (`edgeStiffness`, `bendStiffness`); elastic stiffness is no longer silently clamped to
  18 (default 12, ratio 0.75); negative ease is measured against the girth under each point
  (`GarmentShell.girth`), reading merged defaults (`garmentSettings`); the plan's limb
  distances are carried onto the shell's re-filleted limbs; the batwing dart's 0.18 m is
  `xWithin` from the shoulder; a flared garment whose hem is above the hip no longer blows
  the grid up, and the grid no longer always reaches the floor; prints are stored once and
  shared as one texture per print and colour; the layer push is shared by barycentric weight.

Measured and not Gemini's: short sleeves flatten at 6–7% at HEAD too (bound 5% for wovens)
— since the muscle relief (0fa0a7b). Straightening bent limbs before flattening (which
Gemini removed) is mixed: jacket lower sleeves 2.2% with vs 4.4% without, sock 8.0% vs 3.3%;
left removed.

Strain limits: Gemini made them compliant up to the fabric's `give`. Measured A/B over both
test files: hard 50 pass / 5 fail, give-compliant 49 / 6 — the shade sail in wind fails
only compliant, and nothing passes only compliant (the spandex drum wrap and the
negative-ease top pass hard too). Back to hard. The ballgown failed to load in the browser
("max call stack"): `BC.push(...m.bendRest)` in the solver, more stencils than a worker's
stack takes arguments; now loops.

Suite now (both files, 2026-11-07): **50 pass, 5 fail**, all five failing at HEAD too:
short sleeves 6.4–7.4% (bound 5%) since the muscle relief; the gown's modelling (75–86 s,
limit 60 s) and drape (155–164 s, limit 120 s) — the gown shell is slow (grid down to
-0.72 m for the train, H set by the wrist), about 90 s to build in the browser too.

## Session 6 (2026-11-07): gown speed, boned gown preset, three bugs it found

**Gown build** (female form, defaults), shell + flatten: 29.5 s + 38 s → 9 s + 6 s; browser
load of `ballgown_on_form` ~90 s → ~14 s. 50k triangles → 19k.
- `surfaceCoarsen.ts` (new): after the surface net, edges collapsed (shortest first, link
  condition, no normal turned past cos 0.4, none made longer than 4/3 target), flipped toward
  valence 6, smoothed and put back on the field. Target per point = 0.2 x radius of curvature
  (shape operator from the field's Hessian, so saddles count), between H and H_MAX, graded
  1.25x per ring. The grid stays as fine as the thinnest limb needs; the triangles don't.
  At 0.4 the gown front flattened at 5.1% (area-weighted) vs 4.7% off the fine grid; 0.2 → 4.8%.
- `meshSdfWithin` (formSdf): each part's SDF only in its own box (part + its own stand-off +
  7 x BLEND), outside it the box value plus the way there (an upper bound, triangle inequality:
  a far part never reads nearer than it is). Grid = union of boxes; z above the parts no longer
  gets the hem's flare margin.
- `centreY` memoised per 0.1 mm (bodyFormSection was 17 s of the shell).
- Flatten: LSCM and the ARAP Laplacian applied from flat typed arrays (same summation order).
- Boundary-edge cleanup after clipping is relative to the local triangle size.

**Measures changed (both, with numbers):** `strain95` (garmentFlatten) and the test harness's
`strains()` weight each edge by a third of each triangle it bounds. Counted per edge, an adaptive
mesh over-reads its curved parts (finer there, and that is where cloth strains): gown front
7.2% per edge vs 4.8% by area; gown drape p99 9.3% per edge vs 4.2% by area. On the committed
code (uniform fine mesh) the gown drape was already p99 8.4% per edge (5.6% by area) — hidden by
its timeout. Length² weighting was tried first and over-counted a band's long diagonals.

**Bugs the boned gown preset found:**
- A zipper trim on an open seam drew teeth and joined nothing: a zipped strapless gown hung open
  at the back and slid to the floor. Fastened zips now stitch their two sides like buttons
  (`fastened` default true); the jacket default's zip is `fastened: false` (its look unchanged).
- Rods straight at rest: a closed hoop can never be, and with one-pass XPBD (no λ) it fought the
  cloth every pass — edges to 487%; bones straightening over the bust tore the bodice (163%).
  Rods now rest at their modelled curvature (|a+c-2b| from x0). Bodice bones: p99 5.3% vs 5.5% bare.
- Steel hoop weight (0.039 kg/m, 85 g round the skirt) on taffeta: p99 8.8% at the waist even
  with stiffness ~0 (40:1 particle mass ratio). Preset uses a polyester hoop (6.2%).

**Preset** `boned_gown_on_form` (`bonedGown()` in clothPresets): strapless dress top at bust+5 cm,
princess seams to the hem, zip up the centre back, spiral steel in princess + side seams from
waist−6 cm, plastic hoop in a seam at 0.36 m, velvet spencer with a 3 cm button stand lapping left.
Test: holds up (−3 cm), hoop radius 97%, p95 1.0% p99 3.6%.

**Suite** (garments + cloth): 53/56. Failing: the three sleeve flatness cases (6.2/6.2/7.4%,
pre-existing since 0fa0a7b's muscle relief).

## Session 7 (2026-11-07/08): darts anywhere, collars and lapels, fullness, cap ease, bridging

Three sub-agents built features in snapshot worktrees; merged here by 3-way against the snapshot.

**Darts anywhere** (`garmentDarts.ts`): `GarmentDraft.darts: boolean | GarmentDart[]`. A dart is an
apex (`GarmentPoint`: point, landmark, body height, or a place on a limb) plus `direction`/`to`,
`length` (unset: to the first seam), `back` (double-ended), `mirror`. The shell is slit along it
(`dartSlit`); flattened it opens; worn it is sewn. Take-up is not settable: it is what the fitted
shape opens by. Bust/waist darts now come from the same code (same numbers). Fish-eyes are drawn
in the pattern (`FlatPiece.darts`). Legs up to ~10% unequal on the bust dart (as before); forcing
equal legs made every drape worse, so not done.

**Collars and lapels** (`garmentCollars.ts`): `collar {stand, standFront, fall, point, round,
separateStand}` and `lapels {break, width, peak, rollAt, notch, shawl}`. Lapels are the front cut
along its roll line and turned back, in one piece with it; collar modelled on the neckline's own
points, flattened, started folded and pressed; real gorge seam; shawl in one with the fronts, CB
seam. A one-piece collar over a 3 cm stand cuts flat at 8.3% vs ~3% split, so presets split stands.
Shawl right half 6.7% (its test bound 7.5%: should come down with ease on the under-collar).

**Fullness** (`garmentFullness.ts`, `garmentSpread.ts`): `fullness: [{along, kind: ease|gather|
knife|box|inverted, ratio, count|at, from/to, stitched, pressed, facing, side, panels}]`. Slash and
spread in the flat piece, remeshed, started folded, tacked to the seam. Spread cloth rests at its
folded curvature (flat rest never settles in one-pass XPBD: 120 mm/s at 5 s); unpressed pleats
relax to flat below their stitching. Pleat fix: start-shape interpolation bug, press tacks aimed in
the folded start, layers at the fabric's thickness (not the 4 mm contact): unpressed p99 8.3→4.9%.
Left: stitched band still ~2.5% of edges over 5% (seam load path). Pieces mode with fullness does
not settle (7.6 mm/s). Fullness across a dart mismatches its legs.

**Sleeves (the three old failures):** cause was the new shoulder (0fa0a7b): the cap is a dome.
All three passed on the commit before. Fix: fabrics now have `easeIn` (how far they can be eased
in: woven 6%, denim 4%, canvas 3%, taffeta/velvet 2%, leather/knits 0). Cap ease = easeIn up to
CAP_NEED 6%; where the fabric can neither ease nor give that, the plan adds a cap dart (like bust
darts). Dress sleeve 4.75%, leather jacket upper sleeve 3.9%.

**Bridging** (`formSdf.closeSdf`, `BRIDGE`/`HUG_GIVE` in garmentShell): each form part closed by a
ball of 4 cm × (1 − give/0.4) before ease (woven ~4 cm, jersey ~2.5, spandex 0). User wants it for
realism; measured it fixes no flatness case and costs ~0.1-0.2 s. Visual effect not yet checked.

**Open:** jacket drops 3-5 cm on release (shell stands its full ease above shoulders/upper back).
Hanging on up-facing surfaces + fitting the bodice close to the bust line fixed it (≤1 cm) but
broke six tests (collars, tucks, shoulder cut, leg warmer); backed out, needs redoing.
clothModel.ts is 899 lines, garmentSpread 608, garmentCollars 581: split them.

**Presets:** `darted_sheath_on_form`, `shirt_and_jacket_on_form`, `gathers_and_pleats_on_form`.

## Session 8 (2026-11-08): garments hang on release (the jacket drop)

**Cause measured:** the shell stood its ease off the form all round, over the shoulders too, so
on release it fell until something held it. Drop of the top 8 cm in 2.5 s (scratch probe):
jacket 40 mm, t-shirt 15, woven shirt (F) 18, dress 6, jeans 45.

**Fix (garmentShell field):** each part's girth ease hangs below it, not round it. A grid
point's surface is the form's moved down by the ease there (`sink` = blended stand-off minus
`restOff(layer)`, without flare; one move per point for every part, blended as the ease is —
moved per part, an arm's root stood up through a body moved further down). Distances *and*
stand-offs are read at the lifted point (a flare is by height on the body; the sink is found
by 3 fixed-point steps, since a snug band eases off above). Up-facing surfaces end at rest
clearance, down-facing get the slack, vertical ones are unchanged; girths are kept.
**Cuts and seams are made on the surface lifted back up by its sink, then let down**
(`shell.hang` per point): cut where it hangs, a waist seam was the form's girth from higher up,
loose, and slid 7 cm down the hips under a gathered skirt. Collars and lapels
(clothModel) are modelled on the lifted shell too and let down by the nearest shell point's
hang (shawl fronts 8.9/9.6% -> 5.7-7.1%).
Now: jacket 9 mm, t-shirt 2, woven shirt 3, dress 0, jeans 35 (their waistband is cut 2 cm
loose and slides down the waist-hip taper: real, by the draft).

**Tried and dropped, measured:**
- Rigid drop of the finished shell until it rests (tension-only supports): helped only
  ring-held garments (jeans 45 -> 21) and broke socks (sole pushed into the floor), leg warmers
  (held by grip, not gravity: dropped the full cap), one-shoulder.
- Lifting only by stand-off past rest (so a shoulder is cut where it lies): back of a waist cut
  at another height from its front; collars and gathers failed again.
- Snug band following the neckline's dip (back neck fitted to the neck base): neckline right
  (1.471 vs 1.450), but collar modelling got worse (shawl 7.8/9.2%, jacket stand kept 52%).
  The collar builder copes badly with a neckline lying close on the neck-shoulder flare; the
  hung jacket's back neck is still ~2.5 cm below where it is cut. Open, in garmentCollars.

**Bugs found on the way, fixed:**
- Sliver absorb (garmentShell): by area (< 1% of the largest panel), not < 6 triangles, and a
  dissolved seam edge mid-chain now splits the seam (only a seam's *first* edge was checked;
  jeans grew a 10-triangle `frontR` scrap at the crotch).
- Shawl collar halves split at half the run's arc, not the centre back: run on along two gorges
  it is not symmetric (seam stood 1.5 cm off at HEAD, 4 cm with the hung shell). Now where the
  neckline crosses x = 0 behind the neck; the stand's back-to-front blend too.
- Ballgown bow tails started 11 mm inside the form and up to 3 cm inside the gown (hung straight
  down from the knot) and were flung out 7 cm by the settle: they now lean back along the line
  from the knot that clears the back (preset, from the form).

- A body form anywhere but the origin (the two forms of `gathers_and_pleats_on_form`) had its
  torso, head and limbs drawn at the origin and only its capsule hands and feet where it stood:
  its mesh geoms were static, which the viewport draws as world space, while their vertices are
  in the form's frame (as the compiler places them). `clothNodes` now promotes a form's meshes
  to dynamic (drawn at the body's transform).

**Tests changed (with measurements):** one-shoulder: the kept side within 1 cm of the form's
own top over the shoulder (the strap now rests on it at 1.373 vs the form's 1.374; the old
bound bust+17 cm was tuned to a strap standing 2-3 cm proud). Unpressed pleats "near the hem":
5 cm above the hung hem's highest point, not a fixed height — the fixed slice cut the ragged
hem and read x0.89 (less cloth than the way round); measured properly HEAD reads x1.18, so the
1.15 bound was never met. Left failing, honestly.

**Suite (garments + cloth), 2026-11-08:** 62/65 (HEAD of the session: 65/65) plus the new
'starts where it hangs' (jacket 9.5 mm, t-shirt 2.4 mm; bounds 15/6). Failing: unpressed pleats
near the hem (x1.2, bound 1.15, also over at HEAD when measured right); the bow tails can cross
(no cloth self-collision, their end x is a pendulum outcome after sewing ends at 1 s: passes or
fails by a centimetre); shawl roll kept 10.2 mm of 13.6 (bound 75%, misses by microns: the
low back neck above).

## Next session: cloth self-collision (missing, a major gap)

Cloth does not collide with itself. The solver keeps cloth off the colliders (the form) and an
outer garment off an inner one (`clothLayers.ts`, one way, by `layer`), but nothing keeps a
piece off itself or off another piece on the same layer. Seen as: the ballgown bow's tails
swing through each other when its sewing ends at 1 s (the 'holds a bow' test passes or fails by
a centimetre on where the swing stops); pleats, gathers and folds can pass through each other;
a skirt's folds, a sleeve against the body of its own garment, a collar's fall against its
stand, a lapel against its front are all unprotected.

What exists to build on: `LayerContacts` (spatial hash of triangles, rebuilt every REBUILD
substeps with boxes grown by MOVE_MARGIN; point-vs-triangle at CLOTH_THICKNESS; "side it was on
at the start of the substep" for non-garment cloth). What self-collision needs beyond it:
point-vs-triangle within a piece, excluding the triangles round the point (its n-ring, by flat
distance under ~2 x thickness, so a fold's two sides still count); a two-way push (point and the
triangle's corners, by inverse mass and barycentric weight) instead of the layers' one-way;
side memory per point-triangle pair so a fold that crosses in one substep is put back, not
locked through; probably edge-edge for thin crossings (tails edge-on); and cost — the layer
note says a per-substep rebuild cost more than the rest of the solver, at 600 Hz x 3 passes in a
browser. Test it on the bow (tails never cross), a folded strip dropped on itself, the pleats,
and the full presets' frame time.

## Session 9 (2026-11-08/09): forms decomposed, self-collision, the bow, a geometric audit

**Gathered dress / pleated skirt fell off the form (browser only).** The store decomposes a form
(a torso slice's solidity 0.8995 < 0.92), and `demoteDecomposedGeom` (csg.ts) dropped a decomposed
body's *dynamic* drawn meshes from the model; since session 8 a form's meshes are dynamic, so the
cloth (which reads mesh colliders from the model by geom name, clothWorld) kept only the capsules.
The headless harness never decomposes, so it passed. Now `resolveCsgGeoms(node, 'physics',
{ keepDrawn })`: with cloth in the scene (mjcfPrepare) they stay, massless, out of contact.
Test: garments.test.ts 'a form collides as everything drawn even once it is decomposed' (0 of 6
mesh colliders without the fix).

**Self-collision** (`clothSelf.ts`, on by default, `ClothSpec.selfCollide: false` turns it off):
point vs triangle within a layer (its own piece and the others on its layer), two-way (point and
corners by inverse mass and barycentric weight), side = where the point was at the start of the
substep, friction on the relative tangential motion, separation = the two fabrics' half
thicknesses (>= 1 mm). Neighbours excluded: a point's own triangles and those of what is sewn or
tacked to it (walk at 1.5 x separation). A wider radius (separation + longest local edge) let both
sides of a sharply folded seam (crotch, collar roll, gathered waist) pass through: measured,
menswear 17 -> 12 crossings, gathers 237 -> 169, ballgown 4 -> 2. Cost: once a substep (last
stretch pass), per-point candidate lists built at each hash rebuild (most points have none):
ballgown 13.8 vs 10.7 s per sim second, gathers 11.0 vs 8.2 (first version was 4x).
Replaced clothLayers' one-way topological-band self contact for non-garment cloth.
Test: tests/clothSelf.test.ts (a strip folded on itself rests 0.94 mm over itself; off, 0.00).

**The bow drawn inside the gown.** The settle ran on the first substep, so a paused scene drew the
modelled start (tails up to 38 mm inside the gown: the preset's back estimate predates the hung
shell). `ClothSim.settleNow()` runs at build (clothWorld), and in the settle cloth over a garment
is looked for 80 mm deep (`SETTLE_DEPTH`, clothLayers; the garment's outward normal says which side
is out). Measured exactly (probe): no bow point inside the gown at t0 or after, 4.8 mm held; no gown
point through the bow either.

**Geometric audit** (`tests/clothIntersections.ts`, harness `crossings()`): every cloth edge through
a cloth triangle it is not joined to (shared or stitched particles). Presets at 3 s (narrow rule):
tshirt, dress, knitwear, skirt, sheath, sail 0; ballgown 2 (bow on itself); boned gown 0 (134 at
t0, spencer sleeve, settles out); menswear 12 (jeans crotch); gathers 169; tailored 238 (pockets
through backs, belt loop through pocket, stretch top armholes); shirt+jacket 584 (collar fall
through stand, jacket collar through shirt collar). Almost all within 1 cm of a seam or tack.
Most exist at the first frame: contact keeps the side a point starts on, so a start built
crossed stays crossed.

**Untangling** (`clothUntangle.ts`, intersection contour minimisation): unit tests pass (a bump
through a sheet; a bump through the top of three layers 1 mm apart, never crossing the third).
**Not run** (settleNow): on garments it diverges. Cause measured: the tacks. Without tacks in the
restore between steps, gathers 129 -> 22; with them, 129 -> 711. Tacks start on the right side
(6 of ~1500 wrong, gathered back tucks). The real conflict: tacked layers sit a fabric's thickness
(~1 mm) apart, while each layer's triangles (1-2 cm) deviate from the true curved surface by
L^2/8R (0.6 mm at R 5 cm, more in a pleat's fold) - two independently meshed curved layers 1 mm
apart cross wherever their triangles do not line up. Restoring the cut lengths between steps also
re-tangled (edges toward cut length with no contact); restore now holds the lengths at untangle
start. Open decision for the user: layer spacing vs mesh (finer mesh where layers are tacked, or
tacked layers spaced at the mesh's sagitta / the drawn 4 mm slab), and what crossing depth counts.

**Suite** (garments + cloth + clothSelf), before the settle-at-build/untangle work: 66/70. Failing:
gown drape timeout (167 s, limit 120; self-collision cost, since cut 4x -> 1.3x, not rerun), bow
tails cross (x test; the tails may now lie over each other), unpressed pleats x1.153 (bound 1.15),
shawl roll (microns). Scratch probes: tests/_audit.test.ts, _bowprobe, _perfprobe.

## Session 10 (2026-11-09): sagitta gap, crossings built in at the start

**User's decision:** tacked layers vs mesh resolution -> gap by sagitta. `clothSelf.ts`: each
particle keeps its half thickness plus the largest sagitta of its edges (L|dn|/8, vertex normals),
up to half the drawn slab (2 mm); recomputed at each hash rebuild (`SelfContacts.extra`). Tacks
hold off by the same extra (`xpbd.solveTacks`). A contact only counts for a triangle the point is
over to within the separation (a coplanar neighbour on its own sheet is no fold).
Measured, t=3 s crossings (audit, before -> gap): gathers 188 -> 118, shirt+jacket 585 -> 429,
tailored 231 -> 216, menswear 12 -> 10. Only the shallow ones went: the rest were 1-5 mm deep and
present at t0, i.e. built crossed. Fixed by cause (scratch probes `tests/_standprobe`, `_pocketprobe`):
- **Button stand** row 0 started on the over front's edge = in the under front's surface at the
  meeting line: now started (and fastened, held) its offset off the under front, the over front's
  edge raised with it. Shirt 108 -> 0, jacket 80 -> 10 (< 1 mm).
- **Pockets/loops/belt** meshed at the garment's nominal spacing (a back pocket: 15 points, 4.5 cm
  edges over a seat meshed at 2.2 cm: chords sagged 3 mm through it, every point 3.5 mm clear): now no
  coarser than the host panel there (`hostEdge`; belt: worn host edges along its line). 35 -> 0.
- **Add-ons stack** (`heightOver`): a patch over an earlier add-on (belt loop over a front pocket's
  top) is held that add-on's height + SEWN_OFF off. 17 -> 0.
After the stand + pocket fixes (t3): tailored 22, shirt+jacket 248 (all jacket collar), gathers 118.
- Tried and reverted: collar stand kept off the neck by its layer's LAYER_GAP — no effect (the
  jacket's neckline is so far out that the stand's lean never brings it near the shirt's stand).

**Open:** jacket collar self-crossings at the gorge ends (cols near the lapels: stand and fall
offset from a neck run with a sharp corner fan through each other on its inside); collar vs the
shirt collar at the back at t0 (resolves by t3); pleats/gathers 118; untangle diverges even from
small counts (tailored 11 -> 874), so the untangler itself is at fault on garments, not only the
tacks — off. MEASURE-ONLY env switches (CLOTH_NOGAP in clothSelf, CLOTH_UNTANGLE in xpbd) to remove.

**Form (sub-agent):** generated geoms `internal` (hidden from the tree, "Show generated parts"),
Measurements card (BodyFormCard), rebuild in a worker on change (useCsgCompile, like brickwork);
inseam + full tailoring set + UI marking of `internal` in progress.

### Session 10b: sculpted silhouettes (step 1 of direct authoring)

The user asked whether avant-garde designers would be satisfied with preset sliders. The answer: no. The order agreed is
(1) sculpt the silhouette, (2) draw curves on the garment (curve cuts, seams and edges), (3) free pattern pieces sewn onto
garments, (4) an open material editor. Presets stay as on-ramps.

- `GarmentDraft.sculpt: GarmentSculpt[]` is a list of dabs `{at, radius, amount, mirror?}` in the garment's frame:
  stand-off added (or taken away) round points, falloff (1-q)^2. A dab and its mirror count as one, taking the
  larger reach.
- `utils/cloth/garmentSculpt.ts`:
  - `sculptField` buckets the dabs, so the shell asks each cell of the field cheaply.
  - `strokeDabs` scales a stroke so it raises a ridge as high as one dab.
- `garmentShell`:
  - The sculpt is added to the blended stand-off after the hang (sink), so it is shape, not girth, and does not
    move the surface down.
  - Drawing in stops at resting on the form.
  - The grid reach grows by 1.25 × the most it pushes out.
- UI: Garment card ▸ Silhouette ▸ "Sculpt on the garment" (`GarmentSculptPanel.tsx`, `store/garmentSculptStore.ts`).
  `scene/useClothSculpt.tsx` gives the cloth mesh a ring cursor and lays a stroke on a left-drag (Shift flips
  push/draw-in); it is saved on pointer up. Marks show until the rebuild lands. Undo is the normal history.
- Measured with `tests/_sculptbuild.test.ts` (scratch). Shoulders +50 mm modelled are +29 mm half-width after 2 s
  of drape. A skirt bubble +120 mm gives +55 mm modelled, and its front flattens at 6.9% strain95 (domes can't lie
  flat).
- Next: darts or seams added automatically where a sculpted panel can't lie flat, then step 2.
- Not yet: MCP docs for `sculpt` (held with the rest).
- Auto darts for sculpting (`utils/cloth/sculptDarts.ts`):
  - Each point's angle deficit (Gaussian curvature) is summed over a dab's reach, only where the sculpt is more
    than 25% of its peak.
  - A group fires over 0.14 rad: a dart down, then up if it gathers over ~0.5 rad, at most 2 per group, running to
    the next seam or edge.
  - With mirrored sculpting, apexes are chosen on +x, and each one's twin is snapped to the surface on the other
    side (mirrored by coordinates, one fell off the cloth by the armhole).
  - Bubble front 6.9% → 3.8% strain95, symmetric pieces. It also holds its shape better (radius 299 mm after drape
    vs 289 mm modelled; it was 315 mm).
  - Four darts per group cut a shoulder into 40-triangle slivers, hence the cap of 2.
- Panel naming (garmentShell): a side letter is added only when same-named panels lie on both sides. A sleeve
  split by a dart was `sleeveRR2`; it is now `sleeveR2`.
- UI moved:
  - Make ▸ Garment and its modal are gone; Make ▸ Dress form stays.
  - The left sidebar has a Garments section (`palette/GarmentPalette.tsx`), folded until a form comes into the
    scene. Its kinds go on the selected form, the selected garment's form, or the first; with none, a new
    female or male form.
  - `frameForm`/`addClothNode` are in `palette/clothStartActions.ts`.
- Garments section moved below Hardware: it is rendered inside `ComponentPalette`, after the Hardware block.

### Session 10c: curves drawn on the garment (step 2)

- `GarmentDraft.curves: GarmentCurve[]` is `{name, kind: 'seam'|'open'|'cut', points, closed?, mirror?}` in the
  garment's frame. `GarmentLine` was taken (it is the type of a line's name), hence `GarmentCurve`.
- `utils/cloth/garmentCurves.ts`:
  - `draftLines` mirrors curves (names get L/R).
  - `surfaceCurve` resamples the drawn curve (4 mm) and projects it onto the surface. An open end within 2.5 cm of
    an open edge, or of a seam already cut, walks on over the surface (re-projecting each step) to it and a little
    past. A straight extension left a curving surface 3 mm short of a neckline and cut nothing off.
  - `curveSlit`: the curve's ribbon (side = tangent × normal) as a signed distance for `splitAlong`, masked to a
    band of 1.2 × triangle size round the curve and not past an end unless that end runs through an edge.
  - `trimOvershoot` takes the bit past a seam off again (up to 1.5 cm); a loose end further from any seam is kept
    (it ends inside a panel, a dart).
  - `penCurve`, `PEN_STEP`: a pen stroke as a curve (closes if it ends within 3 cm of its start; mirrored only if it
    keeps to one side).
- garmentShell:
  - Cuts run after the edges are named. The curve is split; if that parts the cloth, every part touching the line
    but the largest is removed, and the line's edges are named `name`. If it parts nothing, it is left as an open
    slit seam.
  - Seam and open curves are a `{kind: 'curve'}` plan seam after everything else (garmentPlan
    `addDrawnLines`), cut with `runSeam` and trimmed.
- Tests: `tests/garmentCurves.test.ts` (keyhole cut-out, square neckline redrawn, a wavy seam side to side parting
  the front, an open vent, a mirrored pair, `penCurve`). Scratch `tests/_curvebuild.test.ts`: keyhole, a curved seam
  ending inside the front (sewn shut, front 3.3% → 2.5% strain95) and a vent all build and drape with 0 crossings.
- UI: Garment card ▸ Lines ▸ "Draw on the garment" (`GarmentCurvesPanel.tsx`):
  - Seam / Opening / Cut away, and Both sides.
  - A list of the curves with a kind picker and ×.
  - The viewport hook (`useClothSculpt.tsx`) is shared with the brush. `store/garmentSculptStore.ts` now has
    `tool: 'sculpt'|'draw'` and `curveKind`.
- Not yet:
  - editing a drawn curve's points (drag them);
  - trims and rods along a curve by name, which should work since curve seams and edges carry the name, but are
    untested;
  - MCP docs.
