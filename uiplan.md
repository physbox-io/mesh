# UI Polish Plan (`uiplan.md`)

Ideas to give the Mesh UI extra warmth, tactile charm, and visual polish without getting in the way of the workshop workflow.

---

## 1. Tactile Component Tiles in the Left Sidebar ✅ *(Done)*
- [x] **Extract `ComponentPalette`**: Move the primitives, 3D hardware primitives, and "Others" tiles out of `src/App.tsx` into `src/components/ComponentPalette.tsx`.
- [x] **3D Isometric Micro-SVGs**: Replace flat 2D icons and plain text labels (`M3`, `Nut`, `D5`) with shaded 3D isometric SVG illustrations across all primitives, 3D hardware parts (M3 Heat-Set Insert Boss, M3 Nut Trap, M3 Cap Recess, 608 Bearing, D-Shaft Hub), and "Others" (Mesh, SCAD, Add Note Card).
- [x] **Springy Hover & Drag Lift**: Add subtle physical lift (`hover:-translate-y-0.5 hover:shadow-md active:scale-[0.97]`) and icon tilt/spin on hover so picking up a part feels like grabbing a piece out of a parts bin.

---

## 2. Workshop "Bench" Backdrop & Viewport Atmosphere ✅ *(Done)*
- [x] **Subtle Radial Vignette / Studio Cyclorama**: Replace the flat canvas backdrop (`#f8fafc` light / `#0b0f19` dark) with a soft radial studio gradient (warm ivory/slate at the center, gently deeper at the edges) so 3D parts pop off the screen like a real photo booth.
- [x] **Play vs. Edit Mood Shift**: When `isPlaying` flips on, subtly tint or energize the viewport frame/top edge (e.g., a soft amber/emerald live-simulation glow) so "Live Physics" feels distinct from the static CAD bench at a glance.

---

## 3. Livelier Mode Chip & Keycap Badges (`src/components/BottomStatusBar.tsx`)
- [ ] **Tactile Keycaps in the Mode Menu**: Style the shortcut hints (`G`, `R`, `S`, `I`, `K`, `D`, `A`, `Esc`, `1`–`7`) as physical-looking mini keycaps (`border-b-2 border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 rounded px-1.5 py-0.5 font-mono text-[10px] shadow-2xs`).
- [ ] **Animated Mode Dot / Contextual Icon**: Give the active mode pill a tiny contextual icon (e.g., a pulsing indicator during active gestures, crosshairs when measuring, brush/grid icon when sculpting or latticing) with smooth transitions.

---

## 4. Playful Micro-Moments & Celebrations
- [ ] **Copy / Share / Save Micro-Celebration**: Trigger a crisp spring/spark animation on the checkmark when copying a share link, saving a preset, or completing a machine job in `JobSucceededModal`.
- [ ] **Custom Tool Cursors**: When in `Knife` (`K`), `Sculpt`, or `Paint` mode, use crisp custom SVG cursors (e.g., a precision blade for Knife, a brush ring for Paint) instead of the default browser crosshair.
- [ ] **Interactive Axis Gizmo**: Allow clicking the X / Y / Z tips on the top-right axis legend in `src/App.tsx` to smoothly tween the camera to Front, Right, or Top views.

