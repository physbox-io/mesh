import React from 'react';
import type { SceneNode } from '../types/scene';
import type { PhysicsState } from '../store/useStore';
import {
  createHeatSetBossNode,
  createHexNutTrapNode,
  createBearingPocketNode,
  createDShaftHubNode,
  createCounterboreHoleNode,
} from '../utils/hardwareComponents';

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
  onAddNoteCard: () => void;
}

export const ComponentPalette: React.FC<ComponentPaletteProps> = ({
  coarsePointer,
  selectedNodeName,
  onDragStart,
  onAddComponent,
  onAddSculpt,
  onAddLattice,
  onAddHardwareNode,
  onAddNoteCard,
}) => {
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
        {/* Cube (Box) */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'box')}
          onClick={() => onAddComponent('box')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-rose-300 dark:hover:border-rose-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Cube (Box geom)"
        >
          <div className="p-1.5 bg-gradient-to-br from-rose-50 to-rose-100/70 dark:from-rose-950/40 dark:to-rose-900/20 ring-1 ring-rose-200/60 dark:ring-rose-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-3 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <ellipse cx="12" cy="21" rx="7" ry="1.6" className="fill-rose-900/10 dark:fill-black/35" />
              <polygon
                points="12,3 20,7.5 12,12 4,7.5"
                className="fill-rose-200 dark:fill-rose-400/40 stroke-rose-600 dark:stroke-rose-400"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <polygon
                points="4,7.5 12,12 12,20.5 4,16"
                className="fill-rose-400/75 dark:fill-rose-500/45 stroke-rose-600 dark:stroke-rose-400"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <polygon
                points="12,12 20,7.5 20,16 12,20.5"
                className="fill-rose-500/85 dark:fill-rose-700/55 stroke-rose-600 dark:stroke-rose-400"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-rose-600 dark:group-hover:text-rose-400 transition-colors">
            Cube
          </span>
        </div>

        {/* Sphere */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'sphere')}
          onClick={() => onAddComponent('sphere')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-emerald-300 dark:hover:border-emerald-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Sphere (Ball geom)"
        >
          <div className="p-1.5 bg-gradient-to-br from-emerald-50 to-emerald-100/70 dark:from-emerald-950/40 dark:to-emerald-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-6 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <defs>
                <radialGradient id="tile-sphere-grad" cx="35%" cy="30%" r="70%">
                  <stop offset="0%" stopColor="#a7f3d0" />
                  <stop offset="55%" stopColor="#34d399" />
                  <stop offset="100%" stopColor="#059669" />
                </radialGradient>
              </defs>
              <ellipse cx="12" cy="21" rx="6.5" ry="1.5" className="fill-emerald-900/12 dark:fill-black/35" />
              <circle
                cx="12"
                cy="11.5"
                r="8"
                fill="url(#tile-sphere-grad)"
                className="stroke-emerald-600 dark:stroke-emerald-400"
                strokeWidth="1.4"
              />
              <path
                d="M4.2 11.5 C6.5 14.5, 17.5 14.5, 19.8 11.5"
                className="stroke-emerald-800/35 dark:stroke-emerald-200/35"
                strokeWidth="1.1"
                strokeDasharray="2 1.5"
                strokeLinecap="round"
              />
              <ellipse
                cx="9.2"
                cy="8.2"
                rx="2.2"
                ry="1.3"
                transform="rotate(-28 9.2 8.2)"
                className="fill-white/75"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
            Sphere
          </span>
        </div>

        {/* Cylinder */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'cylinder')}
          onClick={() => onAddComponent('cylinder')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-amber-300 dark:hover:border-amber-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Cylinder block"
        >
          <div className="p-1.5 bg-gradient-to-br from-amber-50 to-amber-100/70 dark:from-amber-950/40 dark:to-amber-900/20 ring-1 ring-amber-200/60 dark:ring-amber-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-3 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <defs>
                <linearGradient id="tile-cyl-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#fcd34d" />
                  <stop offset="35%" stopColor="#fde68a" />
                  <stop offset="100%" stopColor="#d97706" />
                </linearGradient>
              </defs>
              <ellipse cx="12" cy="21" rx="7" ry="1.5" className="fill-amber-900/12 dark:fill-black/35" />
              <path
                d="M5 7 V16.5 C5 18.4 8.13 20 12 20 C15.87 20 19 18.4 19 16.5 V7"
                fill="url(#tile-cyl-grad)"
                className="stroke-amber-600 dark:stroke-amber-400"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <ellipse
                cx="12"
                cy="7"
                rx="7"
                ry="3.2"
                className="fill-amber-100 dark:fill-amber-300/75 stroke-amber-600 dark:stroke-amber-400"
                strokeWidth="1.4"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors">
            Cylinder
          </span>
        </div>

        {/* Pole (Capsule) */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'capsule')}
          onClick={() => onAddComponent('capsule')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-indigo-300 dark:hover:border-indigo-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Capsule rod (Pole)"
        >
          <div className="p-1.5 bg-gradient-to-br from-indigo-50 to-indigo-100/70 dark:from-indigo-950/40 dark:to-indigo-900/20 ring-1 ring-indigo-200/60 dark:ring-indigo-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-6 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <defs>
                <linearGradient id="tile-pole-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#c7d2fe" />
                  <stop offset="40%" stopColor="#818cf8" />
                  <stop offset="100%" stopColor="#4f46e5" />
                </linearGradient>
              </defs>
              <ellipse cx="12" cy="21" rx="5.5" ry="1.4" className="fill-indigo-900/12 dark:fill-black/35" />
              <rect
                x="7.5"
                y="3"
                width="9"
                height="16.5"
                rx="4.5"
                fill="url(#tile-pole-grad)"
                className="stroke-indigo-600 dark:stroke-indigo-400"
                strokeWidth="1.4"
              />
              <path
                d="M7.8 7.8 C9.5 9.2, 14.5 9.2, 16.2 7.8"
                className="stroke-indigo-900/30 dark:stroke-indigo-200/30"
                strokeWidth="1"
                strokeDasharray="1.8 1.4"
                strokeLinecap="round"
              />
              <path
                d="M9.8 5.5 V14.5"
                className="stroke-white/70"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
            Pole
          </span>
        </div>

        {/* Gear */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'gear')}
          onClick={() => onAddComponent('gear')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-slate-400 dark:hover:border-slate-600 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Gear cog"
        >
          <div className="p-1.5 bg-gradient-to-br from-slate-100 to-slate-200/80 dark:from-slate-800 dark:to-slate-900 ring-1 ring-slate-300/70 dark:ring-slate-700/60 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-45 transition-transform duration-300">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <defs>
                <linearGradient id="tile-gear-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#e2e8f0" />
                  <stop offset="55%" stopColor="#94a3b8" />
                  <stop offset="100%" stopColor="#475569" />
                </linearGradient>
              </defs>
              <path
                d="M10.5 2.5 H13.5 L14.1 4.7 L16.2 5.6 L18.2 4.3 L20.3 6.4 L19 8.4 L19.9 10.5 L22.1 11.1 V14.1 L19.9 14.7 L19 16.8 L20.3 18.8 L18.2 20.9 L16.2 19.6 L14.1 20.5 L13.5 22.7 H10.5 L9.9 20.5 L7.8 19.6 L5.8 20.9 L3.7 18.8 L5 16.8 L4.1 14.7 L1.9 14.1 V11.1 L4.1 10.5 L5 8.4 L3.7 6.4 L5.8 4.3 L7.8 5.6 L9.9 4.7 Z"
                fill="url(#tile-gear-grad)"
                className="stroke-slate-600 dark:stroke-slate-300"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <circle
                cx="12"
                cy="12.6"
                r="5.2"
                className="fill-slate-200/80 dark:fill-slate-700/70 stroke-slate-500 dark:stroke-slate-400"
                strokeWidth="1"
              />
              <circle
                cx="12"
                cy="12.6"
                r="2.3"
                className="fill-slate-700 dark:fill-slate-950 stroke-slate-600 dark:stroke-slate-300"
                strokeWidth="1.2"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-slate-900 dark:group-hover:text-white transition-colors">
            Gear
          </span>
        </div>

        {/* Wedge */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'wedge')}
          onClick={() => onAddComponent('wedge')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-amber-300 dark:hover:border-amber-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Wedge (Inclined plane)"
        >
          <div className="p-1.5 bg-gradient-to-br from-amber-50 to-amber-100/70 dark:from-amber-950/40 dark:to-amber-900/20 ring-1 ring-amber-200/60 dark:ring-amber-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-3 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <ellipse cx="12" cy="21" rx="7.5" ry="1.5" className="fill-amber-900/12 dark:fill-black/35" />
              <polygon
                points="3.5,15.5 14.5,4 20.5,7.5 11.5,19.5"
                className="fill-amber-200 dark:fill-amber-400/45 stroke-amber-600 dark:stroke-amber-400"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <polygon
                points="11.5,19.5 20.5,7.5 20.5,16"
                className="fill-amber-500/85 dark:fill-amber-600/55 stroke-amber-600 dark:stroke-amber-400"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors">
            Wedge
          </span>
        </div>

        {/* Pyramid */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'pyramid')}
          onClick={() => onAddComponent('pyramid')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-rose-300 dark:hover:border-rose-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Pyramid (Convex mesh)"
        >
          <div className="p-1.5 bg-gradient-to-br from-rose-50 to-rose-100/70 dark:from-rose-950/40 dark:to-rose-900/20 ring-1 ring-rose-200/60 dark:ring-rose-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-3 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <ellipse cx="12" cy="21" rx="7.5" ry="1.5" className="fill-rose-900/12 dark:fill-black/35" />
              <polygon
                points="12,3 3.5,16.5 12,20"
                className="fill-rose-200 dark:fill-rose-400/45 stroke-rose-600 dark:stroke-rose-400"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <polygon
                points="12,3 12,20 20.5,16.5"
                className="fill-rose-500/80 dark:fill-rose-700/55 stroke-rose-600 dark:stroke-rose-400"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-rose-600 dark:group-hover:text-rose-400 transition-colors">
            Pyramid
          </span>
        </div>

        {/* Cone */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'cone')}
          onClick={() => onAddComponent('cone')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-sky-300 dark:hover:border-sky-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Cone (Convex mesh)"
        >
          <div className="p-1.5 bg-gradient-to-br from-sky-50 to-sky-100/70 dark:from-sky-950/40 dark:to-sky-900/20 ring-1 ring-sky-200/60 dark:ring-sky-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-3 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <defs>
                <linearGradient id="tile-cone-grad" x1="15%" y1="30%" x2="90%" y2="70%">
                  <stop offset="0%" stopColor="#e0f2fe" />
                  <stop offset="45%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#0284c7" />
                </linearGradient>
              </defs>
              <ellipse cx="12" cy="21" rx="7.5" ry="1.5" className="fill-sky-900/12 dark:fill-black/35" />
              <path
                d="M12 3 L4.5 17 C4.5 19.1 7.86 20.5 12 20.5 C16.14 20.5 19.5 19.1 19.5 17 Z"
                fill="url(#tile-cone-grad)"
                className="stroke-sky-600 dark:stroke-sky-400"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <path
                d="M11.6 5.5 L7.5 16.8"
                className="stroke-white/70"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors">
            Cone
          </span>
        </div>

        {/* Torus */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'torus')}
          onClick={() => onAddComponent('torus')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-violet-300 dark:hover:border-violet-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Torus (Ring mesh)"
        >
          <div className="p-1.5 bg-gradient-to-br from-violet-50 to-violet-100/70 dark:from-violet-950/40 dark:to-violet-900/20 ring-1 ring-violet-200/60 dark:ring-violet-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-6 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <defs>
                <linearGradient id="tile-torus-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#ddd6fe" />
                  <stop offset="50%" stopColor="#a78bfa" />
                  <stop offset="100%" stopColor="#6d28d9" />
                </linearGradient>
              </defs>
              <ellipse cx="12" cy="20.5" rx="8" ry="1.5" className="fill-violet-900/12 dark:fill-black/35" />
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 5 C6.75 5 2.5 8.13 2.5 12 C2.5 15.87 6.75 19 12 19 C17.25 19 21.5 15.87 21.5 12 C21.5 8.13 17.25 5 12 5 Z M12 9.5 C9.5 9.5 7.5 10.6 7.5 12 C7.5 13.4 9.5 14.5 12 14.5 C14.5 14.5 16.5 13.4 16.5 12 C16.5 10.6 14.5 9.5 12 9.5 Z"
                fill="url(#tile-torus-grad)"
                className="stroke-violet-600 dark:stroke-violet-400"
                strokeWidth="1.4"
              />
              <path
                d="M5.5 9.6 C7.2 7.5, 11 6.7, 14.5 7.2"
                className="stroke-white/75"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors">
            Torus
          </span>
        </div>

        {/* Tube */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'tube')}
          onClick={() => onAddComponent('tube')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-emerald-300 dark:hover:border-emerald-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Tube (Hollow cylinder)"
        >
          <div className="p-1.5 bg-gradient-to-br from-emerald-50 to-emerald-100/70 dark:from-emerald-950/40 dark:to-emerald-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-3 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <defs>
                <linearGradient id="tile-tube-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#6ee7b7" />
                  <stop offset="35%" stopColor="#a7f3d0" />
                  <stop offset="100%" stopColor="#059669" />
                </linearGradient>
              </defs>
              <ellipse cx="12" cy="21" rx="7" ry="1.5" className="fill-emerald-900/12 dark:fill-black/35" />
              <path
                d="M5 7 V16.5 C5 18.4 8.13 20 12 20 C15.87 20 19 18.4 19 16.5 V7"
                fill="url(#tile-tube-grad)"
                className="stroke-emerald-600 dark:stroke-emerald-400"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <ellipse
                cx="12"
                cy="7"
                rx="7"
                ry="3.2"
                className="fill-emerald-100 dark:fill-emerald-300/75 stroke-emerald-600 dark:stroke-emerald-400"
                strokeWidth="1.4"
              />
              <ellipse
                cx="12"
                cy="7"
                rx="3.6"
                ry="1.6"
                className="fill-emerald-800/70 dark:fill-emerald-950 stroke-emerald-700 dark:stroke-emerald-400"
                strokeWidth="1.2"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
            Tube
          </span>
        </div>

        {/* Ellipsoid */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'ellipsoid')}
          onClick={() => onAddComponent('ellipsoid')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-amber-300 dark:hover:border-amber-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Ellipsoid primitive"
        >
          <div className="p-1.5 bg-gradient-to-br from-amber-50 to-amber-100/70 dark:from-amber-950/40 dark:to-amber-900/20 ring-1 ring-amber-200/60 dark:ring-amber-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-6 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <defs>
                <radialGradient id="tile-ellipsoid-grad" cx="35%" cy="30%" r="70%">
                  <stop offset="0%" stopColor="#fef3c7" />
                  <stop offset="55%" stopColor="#fbbf24" />
                  <stop offset="100%" stopColor="#d97706" />
                </radialGradient>
              </defs>
              <ellipse cx="12" cy="20" rx="8" ry="1.5" className="fill-amber-900/12 dark:fill-black/35" />
              <ellipse
                cx="12"
                cy="12"
                rx="9.5"
                ry="5.8"
                fill="url(#tile-ellipsoid-grad)"
                className="stroke-amber-600 dark:stroke-amber-400"
                strokeWidth="1.4"
              />
              <path
                d="M2.8 12 C6 15, 18 15, 21.2 12"
                className="stroke-amber-800/35 dark:stroke-amber-100/35"
                strokeWidth="1"
                strokeDasharray="2 1.5"
                strokeLinecap="round"
              />
              <ellipse
                cx="8.5"
                cy="9.2"
                rx="2.8"
                ry="1.1"
                transform="rotate(-15 8.5 9.2)"
                className="fill-white/75"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors">
            Ellipsoid
          </span>
        </div>

        {/* Ring — a boolean body: ellipsoid minus a piercing ellipsoid */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'ring')}
          onClick={() => onAddComponent('ring')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-rose-300 dark:hover:border-rose-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Ring (an ellipsoid with a second ellipsoid subtracted; a boolean body you can reshape)"
        >
          <div className="p-1.5 bg-gradient-to-br from-rose-50 to-rose-100/70 dark:from-rose-950/40 dark:to-rose-900/20 ring-1 ring-rose-200/60 dark:ring-rose-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-6 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <defs>
                <linearGradient id="tile-ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#fecdd3" />
                  <stop offset="50%" stopColor="#fb7185" />
                  <stop offset="100%" stopColor="#be123c" />
                </linearGradient>
              </defs>
              <ellipse cx="12" cy="21" rx="7" ry="1.4" className="fill-rose-900/12 dark:fill-black/35" />
              <ellipse
                cx="12"
                cy="11.5"
                rx="5"
                ry="6.5"
                className="fill-rose-900/35 dark:fill-rose-950/80"
              />
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 3 C6.75 3 3 6.8 3 11.5 C3 16.2 6.75 20 12 20 C17.25 20 21 16.2 21 11.5 C21 6.8 17.25 3 12 3 Z M12 6.8 C9.1 6.8 6.8 8.9 6.8 11.5 C6.8 14.1 9.1 16.2 12 16.2 C14.9 16.2 17.2 14.1 17.2 11.5 C17.2 8.9 14.9 6.8 12 6.8 Z"
                fill="url(#tile-ring-grad)"
                className="stroke-rose-600 dark:stroke-rose-400"
                strokeWidth="1.4"
              />
              <path
                d="M7.2 9.5 C8.5 7.2, 11.2 6.3, 14.2 6.9"
                className="stroke-white/80"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-rose-600 dark:group-hover:text-rose-400 transition-colors">
            Ring
          </span>
        </div>

        {/* Sculpt */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'sculpt')}
          onClick={onAddSculpt}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-sky-300 dark:hover:border-sky-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Sculpt (a ball of clay you push into shape by hand; detail is added as you brush)"
        >
          <div className="p-1.5 bg-gradient-to-br from-sky-50 to-sky-100/70 dark:from-sky-950/40 dark:to-sky-900/20 ring-1 ring-sky-200/60 dark:ring-sky-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-3 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <defs>
                <radialGradient id="tile-sculpt-grad" cx="35%" cy="30%" r="70%">
                  <stop offset="0%" stopColor="#bae6fd" />
                  <stop offset="55%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#0369a1" />
                </radialGradient>
              </defs>
              <ellipse cx="11" cy="21" rx="6.5" ry="1.4" className="fill-sky-900/12 dark:fill-black/35" />
              <path
                d="M10.5 4.5 C14.5 4.2, 16.5 7.5, 17.5 10.5 C18.5 13.5, 17.8 18.5, 13.5 19.5 C9.5 20.4, 4.5 19, 3.8 14.5 C3.1 10, 6.5 4.8, 10.5 4.5 Z"
                fill="url(#tile-sculpt-grad)"
                className="stroke-sky-600 dark:stroke-sky-400"
                strokeWidth="1.4"
              />
              <path
                d="M9.5 11.5 C11.5 13, 13.8 12.2, 15 10.2"
                className="stroke-sky-900/45 dark:stroke-sky-100/50"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
              <path
                d="M15 9.5 L20.5 3.5"
                className="stroke-amber-600 dark:stroke-amber-400"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <circle cx="14.5" cy="10" r="1.2" className="fill-white/90" />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors">
            Sculpt
          </span>
        </div>

        {/* Lattice */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'lattice')}
          onClick={onAddLattice}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-indigo-300 dark:hover:border-indigo-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Lattice (connect points on a 3D grid into faces, with exact dimensions and optional smoothing)"
        >
          <div className="p-1.5 bg-gradient-to-br from-indigo-50 to-indigo-100/70 dark:from-indigo-950/40 dark:to-indigo-900/20 ring-1 ring-indigo-200/60 dark:ring-indigo-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-3 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <polygon
                points="12,3.5 19.5,7.5 12,11.5 4.5,7.5"
                className="fill-indigo-300/40 dark:fill-indigo-500/30 stroke-indigo-600 dark:stroke-indigo-400"
                strokeWidth="1.2"
              />
              <polygon
                points="4.5,7.5 12,11.5 12,19.5 4.5,15.5"
                className="fill-indigo-400/35 dark:fill-indigo-600/30 stroke-indigo-600 dark:stroke-indigo-400"
                strokeWidth="1.2"
              />
              <polygon
                points="12,11.5 19.5,7.5 19.5,15.5 12,19.5"
                className="fill-indigo-500/45 dark:fill-indigo-700/40 stroke-indigo-600 dark:stroke-indigo-400"
                strokeWidth="1.2"
              />
              <circle cx="12" cy="3.5" r="1.6" className="fill-indigo-600 dark:fill-indigo-300" />
              <circle cx="19.5" cy="7.5" r="1.6" className="fill-indigo-600 dark:fill-indigo-300" />
              <circle cx="4.5" cy="7.5" r="1.6" className="fill-indigo-600 dark:fill-indigo-300" />
              <circle cx="12" cy="11.5" r="1.7" className="fill-amber-500 stroke-white dark:stroke-slate-900" strokeWidth="0.8" />
              <circle cx="4.5" cy="15.5" r="1.5" className="fill-indigo-600 dark:fill-indigo-300" />
              <circle cx="19.5" cy="15.5" r="1.5" className="fill-indigo-600 dark:fill-indigo-300" />
              <circle cx="12" cy="19.5" r="1.6" className="fill-indigo-600 dark:fill-indigo-300" />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
            Lattice
          </span>
        </div>

        {/* Curve */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'curve')}
          onClick={() => onAddComponent('curve')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-orange-300 dark:hover:border-orange-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Curve (rigid spline track that balls roll along)"
        >
          <div className="p-1.5 bg-gradient-to-br from-orange-50 to-orange-100/70 dark:from-orange-950/40 dark:to-orange-900/20 ring-1 ring-orange-200/60 dark:ring-orange-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-3 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <path
                d="M3 16.5 C7 16.5, 8.5 7.5, 13.5 7.5 C17.5 7.5, 18.5 14.5, 21 14.5"
                className="stroke-orange-700/60 dark:stroke-orange-500/50"
                strokeWidth="4.2"
                strokeLinecap="round"
              />
              <path
                d="M3 15 C7 15, 8.5 6, 13.5 6 C17.5 6, 18.5 13, 21 13"
                className="stroke-orange-400 dark:stroke-orange-300"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <circle
                cx="13"
                cy="4.2"
                r="2.2"
                className="fill-rose-500 stroke-white dark:stroke-slate-900"
                strokeWidth="0.9"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-orange-600 dark:group-hover:text-orange-400 transition-colors">
            Curve
          </span>
        </div>

        {/* Pulley Wheel */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'pulley_wheel')}
          onClick={() => onAddComponent('pulley_wheel')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-cyan-300 dark:hover:border-cyan-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Pulley Stand system disk"
        >
          <div className="p-1.5 bg-gradient-to-br from-cyan-50 to-cyan-100/70 dark:from-cyan-950/40 dark:to-cyan-900/20 ring-1 ring-cyan-200/60 dark:ring-cyan-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-45 transition-transform duration-300">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <defs>
                <radialGradient id="tile-pulley-grad" cx="35%" cy="30%" r="70%">
                  <stop offset="0%" stopColor="#cffafe" />
                  <stop offset="60%" stopColor="#22d3ee" />
                  <stop offset="100%" stopColor="#0891b2" />
                </radialGradient>
              </defs>
              <circle
                cx="12"
                cy="12"
                r="8.5"
                fill="url(#tile-pulley-grad)"
                className="stroke-cyan-600 dark:stroke-cyan-400"
                strokeWidth="1.4"
              />
              <circle
                cx="12"
                cy="12"
                r="5.6"
                className="fill-cyan-100/80 dark:fill-cyan-950/70 stroke-cyan-600/70 dark:stroke-cyan-400/70"
                strokeWidth="1.1"
              />
              <path d="M12 6.4 V17.6 M6.4 12 H17.6" className="stroke-cyan-600/60 dark:stroke-cyan-400/60" strokeWidth="1.1" />
              <circle
                cx="12"
                cy="12"
                r="2.2"
                className="fill-cyan-700 dark:fill-cyan-300 stroke-white dark:stroke-slate-900"
                strokeWidth="1"
              />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors">
            Pulley
          </span>
        </div>

        {/* Rope */}
        <div
          draggable
          onDragStart={(e) => onDragStart(e, 'pulley_rope')}
          onClick={() => onAddComponent('pulley_rope')}
          className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-emerald-300 dark:hover:border-emerald-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
          title="Coupler Rope"
        >
          <div className="p-1.5 bg-gradient-to-br from-emerald-50 to-emerald-100/70 dark:from-emerald-950/40 dark:to-emerald-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-6 transition-transform duration-200">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
              <path
                d="M5 18 C5 10, 11 14, 12 10 C13 6, 19 10, 19 5"
                className="stroke-emerald-700 dark:stroke-emerald-500"
                strokeWidth="3.4"
                strokeLinecap="round"
              />
              <path
                d="M5 18 C5 10, 11 14, 12 10 C13 6, 19 10, 19 5"
                className="stroke-emerald-300 dark:stroke-emerald-200"
                strokeWidth="1.8"
                strokeDasharray="2.2 2.2"
                strokeLinecap="round"
              />
              <circle cx="5" cy="18.5" r="2" className="fill-emerald-500 stroke-emerald-700 dark:stroke-emerald-300" strokeWidth="1.2" />
              <circle cx="19" cy="4.5" r="2" className="fill-emerald-500 stroke-emerald-700 dark:stroke-emerald-300" strokeWidth="1.2" />
            </svg>
          </div>
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
            Rope
          </span>
        </div>
      </div>

      {/* 3D-Printed Mechanical Hardware Primitives */}
      <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <span>🔩 3D Hardware Primitives</span>
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {/* M3 Heat-Set Insert Boss */}
          <button
            onClick={() => onAddHardwareNode(createHeatSetBossNode('M3'))}
            className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-emerald-300 dark:hover:border-emerald-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
            title="M3 Heat-Set Insert Boss"
          >
            <div className="p-1.5 bg-gradient-to-br from-emerald-50 to-emerald-100/70 dark:from-emerald-950/40 dark:to-emerald-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-3 transition-transform duration-200">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                <defs>
                  <linearGradient id="tile-boss-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#6ee7b7" />
                    <stop offset="35%" stopColor="#a7f3d0" />
                    <stop offset="100%" stopColor="#059669" />
                  </linearGradient>
                  <linearGradient id="tile-brass-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#fde68a" />
                    <stop offset="50%" stopColor="#fbbf24" />
                    <stop offset="100%" stopColor="#b45309" />
                  </linearGradient>
                </defs>
                <ellipse cx="12" cy="21.2" rx="7.5" ry="1.4" className="fill-emerald-900/12 dark:fill-black/35" />
                {/* Printed plastic standoff boss */}
                <path
                  d="M4.5 9.5 V17 C4.5 19 7.86 20.5 12 20.5 C16.14 20.5 19.5 19 19.5 17 V9.5"
                  fill="url(#tile-boss-grad)"
                  className="stroke-emerald-600 dark:stroke-emerald-400"
                  strokeWidth="1.3"
                />
                <ellipse
                  cx="12"
                  cy="9.5"
                  rx="7.5"
                  ry="3"
                  className="fill-emerald-100 dark:fill-emerald-200/80 stroke-emerald-600 dark:stroke-emerald-400"
                  strokeWidth="1.3"
                />
                {/* Knurled brass heat-set insert sitting proud in the bore */}
                <path
                  d="M8 4.8 V9.2 C8 10.4 9.8 11.3 12 11.3 C14.2 11.3 16 10.4 16 9.2 V4.8"
                  fill="url(#tile-brass-grad)"
                  className="stroke-amber-700 dark:stroke-amber-400"
                  strokeWidth="1.2"
                />
                <path
                  d="M9.6 6 L10.6 10.5 M12 6.2 L13 10.7 M14.3 5.8 L15 9.8"
                  className="stroke-amber-900/55"
                  strokeWidth="1"
                  strokeLinecap="round"
                />
                <ellipse
                  cx="12"
                  cy="4.8"
                  rx="4"
                  ry="1.6"
                  className="fill-amber-200 stroke-amber-700 dark:stroke-amber-300"
                  strokeWidth="1.2"
                />
                <ellipse cx="12" cy="4.8" rx="1.9" ry="0.75" className="fill-amber-950/85" />
              </svg>
            </div>
            <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
              M3 Insert Boss
            </span>
          </button>

          {/* M3 Hex Nut Trap */}
          <button
            onClick={() => onAddHardwareNode(createHexNutTrapNode('M3'))}
            className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-blue-300 dark:hover:border-blue-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
            title="M3 Hex Nut Trap Slot"
          >
            <div className="p-1.5 bg-gradient-to-br from-blue-50 to-blue-100/70 dark:from-blue-950/40 dark:to-blue-900/20 ring-1 ring-blue-200/60 dark:ring-blue-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-6 transition-transform duration-200">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                <ellipse cx="12" cy="20.8" rx="7.5" ry="1.5" className="fill-blue-900/12 dark:fill-black/35" />
                {/* 3D Isometric Hex Nut — 3 visible side facets */}
                <polygon
                  points="3.5,9.5 8,13.2 8,18.5 3.5,14.8"
                  className="fill-blue-300 dark:fill-blue-400/60 stroke-blue-600 dark:stroke-blue-400"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
                <polygon
                  points="8,13.2 16,13.2 16,18.5 8,18.5"
                  className="fill-blue-400 dark:fill-blue-500/70 stroke-blue-600 dark:stroke-blue-400"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
                <polygon
                  points="16,13.2 20.5,9.5 20.5,14.8 16,18.5"
                  className="fill-blue-600/85 dark:fill-blue-700/80 stroke-blue-600 dark:stroke-blue-400"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
                {/* Lit top hexagonal face */}
                <polygon
                  points="8,5.5 16,5.5 20.5,9.5 16,13.2 8,13.2 3.5,9.5"
                  className="fill-blue-100 dark:fill-blue-200/75 stroke-blue-600 dark:stroke-blue-400"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
                {/* Threaded M3 center bore */}
                <ellipse
                  cx="12"
                  cy="9.35"
                  rx="3.6"
                  ry="2.1"
                  className="fill-blue-900/85 dark:fill-slate-950 stroke-blue-700 dark:stroke-blue-300"
                  strokeWidth="1.2"
                />
              </svg>
            </div>
            <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
              M3 Nut Trap
            </span>
          </button>

          {/* M3 Counterbore Cap Recess */}
          <button
            onClick={() => onAddHardwareNode(createCounterboreHoleNode('M3'))}
            className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-cyan-300 dark:hover:border-cyan-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
            title="M3 Counterbored Screw Hole (Cap Screw Recess + Shank Clearance)"
          >
            <div className="p-1.5 bg-gradient-to-br from-cyan-50 to-cyan-100/70 dark:from-cyan-950/40 dark:to-cyan-900/20 ring-1 ring-cyan-200/60 dark:ring-cyan-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-3 transition-transform duration-200">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                <defs>
                  <linearGradient id="tile-cbore-top" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#a5f3fc" />
                    <stop offset="40%" stopColor="#67e8f9" />
                    <stop offset="100%" stopColor="#0891b2" />
                  </linearGradient>
                  <linearGradient id="tile-cbore-shank" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#67e8f9" />
                    <stop offset="100%" stopColor="#0e7490" />
                  </linearGradient>
                </defs>
                <ellipse cx="12" cy="21.2" rx="5" ry="1.2" className="fill-cyan-900/12 dark:fill-black/35" />
                {/* Narrow shank clearance cylinder below */}
                <path
                  d="M8.2 12 V18.8 C8.2 20 9.9 20.8 12 20.8 C14.1 20.8 15.8 20 15.8 18.8 V12"
                  fill="url(#tile-cbore-shank)"
                  className="stroke-cyan-600 dark:stroke-cyan-400"
                  strokeWidth="1.3"
                />
                {/* Wide counterbore socket cap recess above */}
                <path
                  d="M4.5 6.2 V11.5 C4.5 13.4 7.86 14.8 12 14.8 C16.14 14.8 19.5 13.4 19.5 11.5 V6.2"
                  fill="url(#tile-cbore-top)"
                  className="stroke-cyan-600 dark:stroke-cyan-400"
                  strokeWidth="1.3"
                />
                <ellipse
                  cx="12"
                  cy="6.2"
                  rx="7.5"
                  ry="2.8"
                  className="fill-cyan-100 dark:fill-cyan-200/80 stroke-cyan-600 dark:stroke-cyan-400"
                  strokeWidth="1.3"
                />
                {/* Hex key socket drive in cap */}
                <polygon
                  points="9.4,5.4 14.6,5.4 16,6.2 14.6,7 9.4,7 8,6.2"
                  className="fill-cyan-900/85 dark:fill-slate-950"
                />
              </svg>
            </div>
            <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors">
              M3 Cap Recess
            </span>
          </button>

          {/* 608 Skate Bearing Pocket */}
          <button
            onClick={() => onAddHardwareNode(createBearingPocketNode('608'))}
            className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-amber-300 dark:hover:border-amber-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
            title="608 Skate Bearing Pocket"
          >
            <div className="p-1.5 bg-gradient-to-br from-amber-50 to-amber-100/70 dark:from-amber-950/40 dark:to-amber-900/20 ring-1 ring-amber-200/60 dark:ring-amber-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-45 transition-transform duration-300">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                <defs>
                  <linearGradient id="tile-bearing-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#fef3c7" />
                    <stop offset="50%" stopColor="#fbbf24" />
                    <stop offset="100%" stopColor="#b45309" />
                  </linearGradient>
                </defs>
                {/* Outer steel race */}
                <circle
                  cx="12"
                  cy="12"
                  r="8.8"
                  fill="url(#tile-bearing-grad)"
                  className="stroke-amber-600 dark:stroke-amber-400"
                  strokeWidth="1.4"
                />
                {/* Deep raceway channel */}
                <circle
                  cx="12"
                  cy="12"
                  r="6.2"
                  className="fill-amber-900/75 dark:fill-slate-950 stroke-amber-700 dark:stroke-amber-400"
                  strokeWidth="1"
                />
                {/* Steel ball bearings in cage */}
                <circle cx="12" cy="5.8" r="1.25" className="fill-amber-200 stroke-amber-700" strokeWidth="0.5" />
                <circle cx="18.2" cy="12" r="1.25" className="fill-amber-200 stroke-amber-700" strokeWidth="0.5" />
                <circle cx="12" cy="18.2" r="1.25" className="fill-amber-200 stroke-amber-700" strokeWidth="0.5" />
                <circle cx="5.8" cy="12" r="1.25" className="fill-amber-200 stroke-amber-700" strokeWidth="0.5" />
                <circle cx="16.4" cy="7.6" r="1.25" className="fill-amber-200 stroke-amber-700" strokeWidth="0.5" />
                <circle cx="7.6" cy="16.4" r="1.25" className="fill-amber-200 stroke-amber-700" strokeWidth="0.5" />
                <circle cx="16.4" cy="16.4" r="1.25" className="fill-amber-200 stroke-amber-700" strokeWidth="0.5" />
                <circle cx="7.6" cy="7.6" r="1.25" className="fill-amber-200 stroke-amber-700" strokeWidth="0.5" />
                {/* Inner steel race & 8mm bore */}
                <circle
                  cx="12"
                  cy="12"
                  r="3.8"
                  fill="url(#tile-bearing-grad)"
                  className="stroke-amber-600 dark:stroke-amber-400"
                  strokeWidth="1.3"
                />
                <circle cx="12" cy="12" r="1.9" className="fill-amber-950 dark:fill-black" />
              </svg>
            </div>
            <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors">
              608 Bearing
            </span>
          </button>

          {/* 5mm D-Shaft Motor Hub */}
          <button
            onClick={() => onAddHardwareNode(createDShaftHubNode(5.0))}
            className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-purple-300 dark:hover:border-purple-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
            title="5mm D-Shaft Motor Hub (NEMA17)"
          >
            <div className="p-1.5 bg-gradient-to-br from-purple-50 to-purple-100/70 dark:from-purple-950/40 dark:to-purple-900/20 ring-1 ring-purple-200/60 dark:ring-purple-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-6 transition-transform duration-200">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                <defs>
                  <linearGradient id="tile-dshaft-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#d8b4fe" />
                    <stop offset="35%" stopColor="#e9d5ff" />
                    <stop offset="100%" stopColor="#7e22ce" />
                  </linearGradient>
                </defs>
                <ellipse cx="12" cy="21" rx="7.5" ry="1.5" className="fill-purple-900/12 dark:fill-black/35" />
                {/* Cylindrical hub body */}
                <path
                  d="M4.5 8.5 V16.5 C4.5 18.7 7.86 20.3 12 20.3 C16.14 20.3 19.5 18.7 19.5 16.5 V8.5"
                  fill="url(#tile-dshaft-grad)"
                  className="stroke-purple-600 dark:stroke-purple-400"
                  strokeWidth="1.3"
                />
                <ellipse
                  cx="12"
                  cy="8.5"
                  rx="7.5"
                  ry="3.4"
                  className="fill-purple-100 dark:fill-purple-200/80 stroke-purple-600 dark:stroke-purple-400"
                  strokeWidth="1.3"
                />
                {/* Distinct flat-chord D-shaft bore */}
                <path
                  d="M8.8 7.1 H15.2 C15.8 7.8 15.9 8.6 15.5 9.3 C14.8 10.3 13.5 10.7 12 10.7 C10.5 10.7 9.2 10.3 8.5 9.3 C8.1 8.6 8.2 7.8 8.8 7.1 Z"
                  className="fill-purple-950 dark:fill-slate-950 stroke-purple-700 dark:stroke-purple-300"
                  strokeWidth="1.1"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">
              D-Shaft Hub
            </span>
          </button>
        </div>
      </div>

      {/* Others */}
      <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <span>🔧 Others</span>
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {/* Mesh */}
          <div
            draggable
            onDragStart={(e) => onDragStart(e, 'mesh')}
            onClick={() => onAddComponent('mesh')}
            className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-violet-300 dark:hover:border-violet-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
            title="Custom static Mesh"
          >
            <div className="p-1.5 bg-gradient-to-br from-violet-50 to-violet-100/70 dark:from-violet-950/40 dark:to-violet-900/20 ring-1 ring-violet-200/60 dark:ring-violet-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:rotate-6 transition-transform duration-200">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                <polygon points="12,2.5 19.5,7 12,9.5" className="fill-violet-200 dark:fill-violet-400/50 stroke-violet-600 dark:stroke-violet-400" strokeWidth="1.2" strokeLinejoin="round" />
                <polygon points="12,2.5 4.5,7 12,9.5" className="fill-violet-100 dark:fill-violet-300/60 stroke-violet-600 dark:stroke-violet-400" strokeWidth="1.2" strokeLinejoin="round" />
                <polygon points="4.5,7 12,9.5 7.5,16" className="fill-violet-300 dark:fill-violet-500/50 stroke-violet-600 dark:stroke-violet-400" strokeWidth="1.2" strokeLinejoin="round" />
                <polygon points="19.5,7 16.5,16 12,9.5" className="fill-violet-400 dark:fill-violet-600/60 stroke-violet-600 dark:stroke-violet-400" strokeWidth="1.2" strokeLinejoin="round" />
                <polygon points="12,9.5 16.5,16 7.5,16" className="fill-violet-300/90 dark:fill-violet-500/65 stroke-violet-600 dark:stroke-violet-400" strokeWidth="1.2" strokeLinejoin="round" />
                <polygon points="4.5,7 7.5,16 3.5,14.5" className="fill-violet-400/80 dark:fill-violet-700/60 stroke-violet-600 dark:stroke-violet-400" strokeWidth="1.2" strokeLinejoin="round" />
                <polygon points="19.5,7 20.5,14.5 16.5,16" className="fill-violet-500/85 dark:fill-violet-800/70 stroke-violet-600 dark:stroke-violet-400" strokeWidth="1.2" strokeLinejoin="round" />
                <polygon points="7.5,16 16.5,16 12,21" className="fill-violet-500/90 dark:fill-violet-700/80 stroke-violet-600 dark:stroke-violet-400" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors">
              Mesh
            </span>
          </div>

          {/* OpenSCAD */}
          <div
            draggable
            onDragStart={(e) => onDragStart(e, 'openscad')}
            onClick={() => onAddComponent('openscad')}
            className="p-2 border border-slate-200/90 dark:border-slate-800 rounded-xl bg-gradient-to-b from-white to-slate-50/70 dark:from-slate-900 dark:to-slate-900/80 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:-translate-y-0.5 hover:shadow-md hover:border-blue-300 dark:hover:border-blue-800/80 active:translate-y-0 active:scale-[0.97] transition-all duration-150 group"
            title="Procedural OpenSCAD shape"
          >
            <div className="p-1.5 bg-gradient-to-br from-blue-50 to-blue-100/70 dark:from-blue-950/40 dark:to-blue-900/20 ring-1 ring-blue-200/60 dark:ring-blue-800/40 rounded-lg mb-1 group-hover:scale-110 group-hover:-rotate-3 transition-transform duration-200">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                <polygon
                  points="12,3 19.5,7 12,11 4.5,7"
                  className="fill-blue-200 dark:fill-blue-400/40 stroke-blue-600 dark:stroke-blue-400"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
                <polygon
                  points="4.5,7 12,11 12,19.5 4.5,15.5"
                  className="fill-blue-400/75 dark:fill-blue-500/45 stroke-blue-600 dark:stroke-blue-400"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
                <polygon
                  points="12,11 19.5,7 19.5,15.5 12,19.5"
                  className="fill-blue-600/80 dark:fill-blue-700/60 stroke-blue-600 dark:stroke-blue-400"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
                <circle
                  cx="12"
                  cy="11"
                  r="3.2"
                  className="fill-amber-200 dark:fill-amber-400/80 stroke-blue-700 dark:stroke-blue-200"
                  strokeWidth="1.2"
                />
              </svg>
            </div>
            <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
              SCAD
            </span>
          </div>

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
