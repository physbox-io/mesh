import React from 'react';
import type { SceneNode } from '../../types/scene';
import type { PhysicsState } from '../../store/useStore';
import type { HardwareCutKind } from '../../types/scene';
import { createDShaftHubNode } from '../../utils/hardwareComponents';
import { HARDWARE_KINDS } from '../../utils/hardwareCuts';
import { PaletteTile, type TileColor, type TileSpin } from './PaletteTile';
import {
  CubeIcon, SphereIcon, CylinderIcon, PoleIcon, GearIcon, WedgeIcon, PyramidIcon, ConeIcon, TorusIcon,
  TubeIcon, EllipsoidIcon, RingIcon, SculptIcon, LatticeIcon, CurveIcon, PulleyIcon, RopeIcon, MeshIcon, ScadIcon,
} from './shapeIcons';
import { InsertBossIcon, NutTrapIcon, CounterboreIcon, BearingPocketIcon, DShaftHubIcon } from './hardwareIcons';

/** What the palette adds by click: every component but the lattice, which has its own handler. */
export type PaletteComponentType = Exclude<Parameters<PhysicsState['addComponent']>[0], 'lattice'>;

export interface ComponentPaletteProps {
  coarsePointer: boolean;
  selectedNodeName: string | null;
  onDragStart: (e: React.DragEvent, type: string) => void;
  onAddComponent: (type: PaletteComponentType) => void;
  onAddSculpt: () => void;
  onAddLattice: () => void;
  onAddHardwareNode: (node: SceneNode) => void;
  /**
   * The selected body that hardware would be cut into, by name, or null when
   * nothing solid is selected — a nut trap is a hole in a part, not a part.
   */
  hardwareTarget: string | null;
  onAddHardwareCut: (kind: HardwareCutKind) => void;
  onAddNoteCard: () => void;
}

interface PartTile {
  /** What a click or a drop adds. */
  type: PaletteComponentType | 'lattice';
  label: string;
  title: string;
  color: TileColor;
  spin: TileSpin;
  slow?: boolean;
  Icon: () => React.JSX.Element;
}

const PART_TILES: PartTile[] = [
  { type: 'box', label: 'Cube', title: 'Cube (Box geom)', color: 'rose', spin: 'group-hover:-rotate-3', Icon: CubeIcon },
  { type: 'sphere', label: 'Sphere', title: 'Sphere (Ball geom)', color: 'emerald', spin: 'group-hover:rotate-6', Icon: SphereIcon },
  { type: 'cylinder', label: 'Cylinder', title: 'Cylinder block', color: 'amber', spin: 'group-hover:-rotate-3', Icon: CylinderIcon },
  { type: 'capsule', label: 'Pole', title: 'Capsule rod (Pole)', color: 'indigo', spin: 'group-hover:rotate-6', Icon: PoleIcon },
  { type: 'gear', label: 'Gear', title: 'Gear cog', color: 'slate', spin: 'group-hover:rotate-45', slow: true, Icon: GearIcon },
  { type: 'wedge', label: 'Wedge', title: 'Wedge (Inclined plane)', color: 'amber', spin: 'group-hover:-rotate-3', Icon: WedgeIcon },
  { type: 'pyramid', label: 'Pyramid', title: 'Pyramid (Convex mesh)', color: 'rose', spin: 'group-hover:rotate-3', Icon: PyramidIcon },
  { type: 'cone', label: 'Cone', title: 'Cone (Convex mesh)', color: 'sky', spin: 'group-hover:-rotate-3', Icon: ConeIcon },
  { type: 'torus', label: 'Torus', title: 'Torus (Ring mesh)', color: 'violet', spin: 'group-hover:rotate-6', Icon: TorusIcon },
  { type: 'tube', label: 'Tube', title: 'Tube (Hollow cylinder)', color: 'emerald', spin: 'group-hover:-rotate-3', Icon: TubeIcon },
  { type: 'ellipsoid', label: 'Ellipsoid', title: 'Ellipsoid primitive', color: 'amber', spin: 'group-hover:rotate-6', Icon: EllipsoidIcon },
  // A boolean body: an ellipsoid minus a piercing ellipsoid.
  { type: 'ring', label: 'Ring', title: 'Ring (an ellipsoid with a second ellipsoid subtracted; a boolean body you can reshape)', color: 'rose', spin: 'group-hover:-rotate-6', Icon: RingIcon },
  { type: 'sculpt', label: 'Sculpt', title: 'Sculpt (a ball of clay you push into shape by hand; detail is added as you brush)', color: 'sky', spin: 'group-hover:rotate-3', Icon: SculptIcon },
  { type: 'lattice', label: 'Lattice', title: 'Lattice (connect points on a 3D grid into faces, with exact dimensions and optional smoothing)', color: 'indigo', spin: 'group-hover:-rotate-3', Icon: LatticeIcon },
  { type: 'curve', label: 'Curve', title: 'Curve (rigid spline track that balls roll along)', color: 'orange', spin: 'group-hover:rotate-3', Icon: CurveIcon },
  { type: 'pulley_wheel', label: 'Pulley', title: 'Pulley Stand system disk', color: 'cyan', spin: 'group-hover:rotate-45', slow: true, Icon: PulleyIcon },
  { type: 'pulley_rope', label: 'Rope', title: 'Coupler Rope', color: 'emerald', spin: 'group-hover:-rotate-6', Icon: RopeIcon },
];

const OTHER_TILES: PartTile[] = [
  { type: 'mesh', label: 'Mesh', title: 'Custom static Mesh', color: 'violet', spin: 'group-hover:rotate-6', Icon: MeshIcon },
  { type: 'openscad', label: 'SCAD', title: 'Procedural OpenSCAD shape', color: 'blue', spin: 'group-hover:-rotate-3', Icon: ScadIcon },
];

/** The hardware cut into a selected part. Sizes are picked afterwards, in its Cut panel. */
const CUT_TILES: { kind: HardwareCutKind; label: string; color: TileColor; spin: TileSpin; slow?: boolean; Icon: () => React.JSX.Element }[] = [
  { kind: 'insert_boss', label: 'Insert Boss', color: 'emerald', spin: 'group-hover:-rotate-3', Icon: InsertBossIcon },
  { kind: 'nut_trap', label: 'Nut Trap', color: 'blue', spin: 'group-hover:rotate-6', Icon: NutTrapIcon },
  { kind: 'counterbore', label: 'Counterbore', color: 'cyan', spin: 'group-hover:-rotate-3', Icon: CounterboreIcon },
  { kind: 'bearing', label: 'Bearing Pocket', color: 'amber', spin: 'group-hover:rotate-45', slow: true, Icon: BearingPocketIcon },
];

export const ComponentPalette: React.FC<ComponentPaletteProps> = ({
  coarsePointer,
  selectedNodeName,
  onDragStart,
  onAddComponent,
  onAddSculpt,
  onAddLattice,
  onAddHardwareNode,
  hardwareTarget,
  onAddHardwareCut,
  onAddNoteCard,
}) => {
  const cutTile = (kind: HardwareCutKind) => ({
    onClick: () => onAddHardwareCut(kind),
    disabled: !hardwareTarget,
    title: hardwareTarget
      ? `${HARDWARE_KINDS[kind].hint} Cut into ${hardwareTarget} where you last clicked it; change its size in the Cut panel.`
      : `${HARDWARE_KINDS[kind].hint} Select a part first: this is cut into it.`,
  });
  const addPart = (type: PartTile['type']) => {
    if (type === 'lattice') onAddLattice();
    else if (type === 'sculpt') onAddSculpt();
    else onAddComponent(type);
  };
  const partTile = (t: PartTile) => (
    <PaletteTile
      key={t.type}
      label={t.label}
      title={t.title}
      color={t.color}
      spin={t.spin}
      slow={t.slow}
      icon={<t.Icon />}
      onClick={() => addPart(t.type)}
      dragType={t.type}
      onDragStart={onDragStart}
    />
  );
  return (
    <>
      <h2 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
        Components
      </h2>

      {/* The palette is drag-and-drop with a mouse, which a finger cannot
          do onto a canvas it cannot see behind the drawer. Tapping already
          adds the part at the origin — it just needed saying. */}
      {coarsePointer && (
        <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-tight mb-1.5">
          Tap a part to drop it into the scene.
        </p>
      )}

      <div className="text-[10px] font-medium text-slate-500 dark:text-slate-400 mb-2.5 bg-slate-50 dark:bg-slate-950/40 px-2 py-1.5 rounded-lg border border-slate-200/50 dark:border-slate-800/50">
        Adding to:{' '}
        <span className="text-blue-600 dark:text-blue-400 font-semibold truncate block">
          {selectedNodeName ? selectedNodeName : '🌍 Worldbody'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {PART_TILES.map(partTile)}
      </div>

      {/* 3D-Printed Mechanical Hardware Primitives */}
      <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <span>🔩 Hardware</span>
        </h3>
        <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500 mb-2">
          {hardwareTarget
            ? <>Cut into <span className="font-semibold text-slate-600 dark:text-slate-300">{hardwareTarget}</span> where you last clicked it. Pick the size in its Cut panel.</>
            : 'Select a part, click where it goes, then pick one. Sizes M2 to M24 are in its Cut panel.'}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {CUT_TILES.map((t) => (
            <PaletteTile
              key={t.kind}
              button
              label={t.label}
              color={t.color}
              spin={t.spin}
              slow={t.slow}
              icon={<t.Icon />}
              {...cutTile(t.kind)}
            />
          ))}
          <PaletteTile
            button
            label="D-Shaft Hub"
            title="5mm D-Shaft Motor Hub (NEMA17)"
            color="purple"
            spin="group-hover:-rotate-6"
            icon={<DShaftHubIcon />}
            onClick={() => onAddHardwareNode(createDShaftHubNode(5.0))}
          />
        </div>
      </div>

      {/* Others */}
      <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <span>🔧 Others</span>
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {OTHER_TILES.map(partTile)}

          {/* Note Card - spans 2 cols */}
          <div
            onClick={onAddNoteCard}
            className="col-span-2 p-2 border border-dashed border-violet-300 dark:border-violet-800 rounded-xl bg-gradient-to-r from-violet-50/40 via-white to-violet-50/40 dark:from-violet-950/20 dark:via-slate-900 dark:to-violet-950/20 flex items-center justify-center gap-2 cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-violet-400 dark:hover:border-violet-600 active:translate-y-0 active:scale-[0.98] transition-all duration-150 group select-none mt-1"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 group-hover:scale-110 group-hover:-rotate-6 transition-transform duration-200" fill="none">
              <path
                d="M5 4 H15 L19 8 V20 H5 Z"
                className="fill-amber-100 dark:fill-amber-400/30 stroke-violet-600 dark:stroke-violet-400"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path
                d="M15 4 V8 H19"
                className="fill-amber-300/80 dark:fill-amber-300/50 stroke-violet-600 dark:stroke-violet-400"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <path d="M8 12 H16 M8 15.5 H13.5" className="stroke-violet-600 dark:stroke-violet-300" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors">
              Add Note Card
            </span>
          </div>
        </div>
      </div>
    </>
  );
};
