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
