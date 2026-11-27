// The palette's hardware tiles: the cut features and the D-shaft hub. Gradient
// ids are global to the page, so each one is prefixed `tile-` and used once.

export const InsertBossIcon = () => (
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
);

export const NutTrapIcon = () => (
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
);

export const CounterboreIcon = () => (
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
);

export const BearingPocketIcon = () => (
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
);

export const DShaftHubIcon = () => (
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
);

// The bought parts that go in those cuts: steel, where the cuts are colour.

export const BearingIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <defs>
      <linearGradient id="tile-part-bearing-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#f1f5f9" />
        <stop offset="55%" stopColor="#94a3b8" />
        <stop offset="100%" stopColor="#475569" />
      </linearGradient>
    </defs>
    <circle cx="12" cy="12" r="9" fill="url(#tile-part-bearing-grad)" className="stroke-slate-500 dark:stroke-slate-300" strokeWidth="1.3" />
    {/* The shield, between the races */}
    <circle cx="12" cy="12" r="6.4" className="fill-slate-600 dark:fill-slate-700 stroke-slate-500" strokeWidth="0.8" />
    {/* The inner race, which turns */}
    <circle cx="12" cy="12" r="4" fill="url(#tile-part-bearing-grad)" className="stroke-slate-500 dark:stroke-slate-300" strokeWidth="1" />
    <circle cx="12" cy="12" r="2.1" className="fill-white dark:fill-slate-900 stroke-slate-500" strokeWidth="0.8" />
  </svg>
);

export const CapScrewIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    {/* Head, with its hex socket */}
    <rect x="6.5" y="2.5" width="11" height="6.5" rx="1.2" className="fill-slate-700 dark:fill-slate-500 stroke-slate-800 dark:stroke-slate-300" strokeWidth="1.1" />
    <path d="M10.2 4.4 H13.8 L14.8 5.75 L13.8 7.1 H10.2 L9.2 5.75 Z" className="fill-slate-900 dark:fill-slate-800" />
    {/* Threaded shank */}
    <rect x="9.5" y="9" width="5" height="12.5" className="fill-slate-600 dark:fill-slate-500 stroke-slate-800 dark:stroke-slate-300" strokeWidth="1.1" />
    {[11, 13.2, 15.4, 17.6, 19.8].map((y) => (
      <path key={y} d={`M9.5 ${y} L14.5 ${y - 1.2}`} className="stroke-slate-300 dark:stroke-slate-800" strokeWidth="0.8" />
    ))}
  </svg>
);

export const HexNutIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <defs>
      <linearGradient id="tile-part-nut-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#f8fafc" />
        <stop offset="60%" stopColor="#94a3b8" />
        <stop offset="100%" stopColor="#64748b" />
      </linearGradient>
    </defs>
    <path d="M12 2.5 L20.2 7.25 V16.75 L12 21.5 L3.8 16.75 V7.25 Z" fill="url(#tile-part-nut-grad)" className="stroke-slate-500 dark:stroke-slate-300" strokeWidth="1.3" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="4.2" className="fill-white dark:fill-slate-900 stroke-slate-500" strokeWidth="1.1" />
  </svg>
);

export const ShaftIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <defs>
      <linearGradient id="tile-part-shaft-grad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#f8fafc" />
        <stop offset="45%" stopColor="#cbd5e1" />
        <stop offset="100%" stopColor="#64748b" />
      </linearGradient>
    </defs>
    <g transform="rotate(-35 12 12)">
      <rect x="2.5" y="9.6" width="19" height="4.8" rx="2.4" fill="url(#tile-part-shaft-grad)" className="stroke-slate-500 dark:stroke-slate-300" strokeWidth="1.1" />
    </g>
  </svg>
);

export const ORingGrooveIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    {/* A face with a round groove in it, and the ring lying in the groove */}
    <rect x="2.5" y="2.5" width="19" height="19" rx="3" className="fill-rose-100 dark:fill-rose-950/40 stroke-rose-400 dark:stroke-rose-500" strokeWidth="1.2" />
    <circle cx="12" cy="12" r="6.2" className="stroke-rose-500 dark:stroke-rose-400" strokeWidth="3.4" />
    <circle cx="12" cy="12" r="6.2" className="stroke-slate-800 dark:stroke-slate-300" strokeWidth="1.8" />
  </svg>
);

export const RimSealIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    {/* A box's rim, seen from above, with cord following it */}
    <rect x="2.5" y="4" width="19" height="16" rx="2" className="fill-rose-100 dark:fill-rose-950/40 stroke-rose-400 dark:stroke-rose-500" strokeWidth="1.2" />
    <rect x="6.5" y="8" width="11" height="8" rx="0.8" className="fill-white dark:fill-slate-900 stroke-rose-300 dark:stroke-rose-600" strokeWidth="0.8" />
    <rect x="4.5" y="6" width="15" height="12" rx="2.2" className="stroke-slate-800 dark:stroke-slate-300" strokeWidth="1.6" />
  </svg>
);

export const LinearRailIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    {/* The rail, end on along the tile, and the carriage riding it */}
    <rect x="2" y="14" width="20" height="4" rx="0.8" className="fill-slate-300 dark:fill-slate-600 stroke-slate-500 dark:stroke-slate-300" strokeWidth="1" />
    {[5, 10, 15, 20].map((x) => <circle key={x} cx={x - 1} cy="16" r="0.8" className="fill-slate-600 dark:fill-slate-900" />)}
    <rect x="7" y="8" width="10" height="7" rx="1.2" className="fill-slate-100 dark:fill-slate-400 stroke-slate-600 dark:stroke-slate-200" strokeWidth="1.1" />
    <path d="M4 6 H8 M16 6 H20" className="stroke-slate-400" strokeWidth="1" strokeLinecap="round" />
  </svg>
);

export const RodBushingIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <rect x="2" y="10.5" width="20" height="3" rx="1.5" className="fill-slate-200 dark:fill-slate-500 stroke-slate-500 dark:stroke-slate-300" strokeWidth="1" />
    <rect x="8" y="7" width="8" height="10" rx="2" className="fill-slate-400 dark:fill-slate-600 stroke-slate-600 dark:stroke-slate-200" strokeWidth="1.1" />
    <path d="M10 7 V17 M14 7 V17" className="stroke-slate-600 dark:stroke-slate-300" strokeWidth="0.7" />
  </svg>
);

export const DrawerRunnerIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    {/* A cabinet, and a drawer on its runners part way out */}
    <rect x="3" y="4" width="15" height="16" rx="1" className="fill-amber-50 dark:fill-amber-950/30 stroke-amber-700 dark:stroke-amber-500" strokeWidth="1.1" />
    <rect x="7" y="9" width="14" height="6" rx="0.8" className="fill-amber-200 dark:fill-amber-800 stroke-amber-700 dark:stroke-amber-400" strokeWidth="1.1" />
    <path d="M4 15.8 H20" className="stroke-slate-500 dark:stroke-slate-300" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

export const RailSeatIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <rect x="2.5" y="5" width="19" height="14" rx="2" className="fill-rose-100 dark:fill-rose-950/40 stroke-rose-400 dark:stroke-rose-500" strokeWidth="1.2" />
    <rect x="4" y="10" width="16" height="4" rx="0.5" className="fill-rose-300 dark:fill-rose-700" />
    {[6, 12, 18].map((x) => <circle key={x} cx={x} cy="12" r="1" className="fill-rose-700 dark:fill-rose-300" />)}
  </svg>
);

export const RodSocketIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <rect x="3" y="3" width="18" height="18" rx="3" className="fill-rose-100 dark:fill-rose-950/40 stroke-rose-400 dark:stroke-rose-500" strokeWidth="1.2" />
    <circle cx="12" cy="12" r="4.2" className="fill-rose-400 dark:fill-rose-700 stroke-rose-600" strokeWidth="1" />
  </svg>
);

export const BushingHousingIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <rect x="3" y="3" width="18" height="18" rx="3" className="fill-rose-100 dark:fill-rose-950/40 stroke-rose-400 dark:stroke-rose-500" strokeWidth="1.2" />
    <circle cx="12" cy="12" r="6.3" className="fill-rose-300 dark:fill-rose-800 stroke-rose-600" strokeWidth="1" />
    <circle cx="12" cy="12" r="2.6" className="fill-white dark:fill-slate-900 stroke-rose-600" strokeWidth="0.8" />
  </svg>
);

export const SpringIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <path d="M7 3 H17 M7 21 H17" className="stroke-slate-600 dark:stroke-slate-300" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M8 5 L16 7.5 L8 10 L16 12.5 L8 15 L16 17.5 L8 19.5" className="stroke-slate-500 dark:stroke-slate-300" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

export const StepperIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <rect x="4" y="7" width="13" height="13" rx="1.5" className="fill-slate-800 dark:fill-slate-600 stroke-slate-900 dark:stroke-slate-300" strokeWidth="1" />
    <rect x="4" y="7" width="13" height="2.5" className="fill-slate-400" />
    <rect x="9.5" y="2.5" width="2" height="5" rx="0.6" className="fill-slate-300 stroke-slate-500" strokeWidth="0.6" />
    <path d="M18.5 11 q2.5 2.5 0 5" className="stroke-blue-500" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

/** A block cut open to show the slot coming in from its side, a nut in it, and the bolt's hole down through. */
export const NutSlotIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <ellipse cx="12" cy="20.8" rx="8.5" ry="1.5" className="fill-blue-900/12 dark:fill-black/35" />
    <rect x="3" y="5" width="18" height="14" rx="1.5" className="fill-blue-200 dark:fill-blue-400/30 stroke-blue-600 dark:stroke-blue-400" strokeWidth="1.3" />
    {/* The bolt's hole, top to bottom */}
    <rect x="10.6" y="5" width="2.8" height="14" className="fill-blue-950/70 dark:fill-black/60" />
    {/* The slot, open to the right-hand side */}
    <rect x="8" y="9.5" width="13" height="5" className="fill-blue-950/80 dark:fill-black/70" />
    {/* The nut, slid in */}
    <polygon points="8.6,12 10,9.9 14,9.9 15.4,12 14,14.1 10,14.1" className="fill-blue-400 dark:fill-blue-500/80 stroke-blue-600 dark:stroke-blue-300" strokeWidth="1" strokeLinejoin="round" />
    <path d="M18.5 12h3.2m-1.4-1.4 1.4 1.4-1.4 1.4" className="stroke-blue-700 dark:stroke-blue-300" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A springy beam on a part with a hooked lip at its top, the lead-in ramp facing up. */
export const SnapHookIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <ellipse cx="12" cy="20.8" rx="8.5" ry="1.5" className="fill-violet-900/12 dark:fill-black/35" />
    <rect x="3" y="16" width="18" height="4" rx="1" className="fill-violet-200 dark:fill-violet-400/30 stroke-violet-600 dark:stroke-violet-400" strokeWidth="1.3" />
    <path d="M9.5 16V5.5h2.6v6.3h3.4L12.1 4H9.5" className="fill-violet-300 dark:fill-violet-500/60 stroke-violet-600 dark:stroke-violet-300" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M14.5 7.5l1.5 -1.5" className="stroke-violet-700 dark:stroke-violet-300" strokeWidth="1" strokeLinecap="round" />
  </svg>
);

/** A wall with a rectangular window, a lip clicked into it. */
export const SnapCatchIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <ellipse cx="12" cy="20.8" rx="8.5" ry="1.5" className="fill-violet-900/12 dark:fill-black/35" />
    <rect x="4" y="3" width="16" height="17" rx="1.5" className="fill-violet-200 dark:fill-violet-400/30 stroke-violet-600 dark:stroke-violet-400" strokeWidth="1.3" />
    <rect x="8" y="8" width="8" height="4.5" className="fill-violet-950/75 dark:fill-black/70" />
    <path d="M9 12.5h4.5l-2-3.5H9z" className="fill-violet-400 dark:fill-violet-500/80" />
  </svg>
);

/** Dark rubber O-ring torus for Bought Parts. */
export const ORingIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <defs>
      <linearGradient id="tile-part-oring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#64748b" />
        <stop offset="45%" stopColor="#334155" />
        <stop offset="100%" stopColor="#0f172a" />
      </linearGradient>
    </defs>
    <ellipse cx="12" cy="20.5" rx="7.5" ry="1.4" className="fill-slate-900/15 dark:fill-black/40" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 5 C6.75 5 2.5 8.13 2.5 12 C2.5 15.87 6.75 19 12 19 C17.25 19 21.5 15.87 21.5 12 C21.5 8.13 17.25 5 12 5 Z M12 8.4 C8.9 8.4 6.5 10 6.5 12 C6.5 14 8.9 15.6 12 15.6 C15.1 15.6 17.5 14 17.5 12 C17.5 10 15.1 8.4 12 8.4 Z"
      fill="url(#tile-part-oring-grad)"
      className="stroke-slate-700 dark:stroke-slate-400"
      strokeWidth="1.2"
    />
    <path
      d="M5.8 9.7 C7.5 7.7, 11 6.9, 14.5 7.4"
      className="stroke-slate-300/65"
      strokeWidth="1.1"
      strokeLinecap="round"
    />
  </svg>
);

/** Knurled brass heat-set threaded insert cylinder for Bought Parts. */
export const HeatSetInsertIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <defs>
      <linearGradient id="tile-part-insert-grad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#fde68a" />
        <stop offset="40%" stopColor="#fbbf24" />
        <stop offset="100%" stopColor="#b45309" />
      </linearGradient>
    </defs>
    <ellipse cx="12" cy="21" rx="6" ry="1.3" className="fill-amber-900/15 dark:fill-black/35" />
    <path
      d="M6.5 6.5 V17 C6.5 18.7 8.96 20 12 20 C15.04 20 17.5 18.7 17.5 17 V6.5"
      fill="url(#tile-part-insert-grad)"
      className="stroke-amber-700 dark:stroke-amber-400"
      strokeWidth="1.3"
    />
    {/* Diagonal knurling bands */}
    <path
      d="M7.5 9.5 L10 12.2 M10.5 9.8 L13 12.5 M13.5 9.6 L16 12.2 M7.5 14 L10 16.7 M10.5 14.3 L13 17 M13.5 14.1 L16 16.7"
      className="stroke-amber-900/60"
      strokeWidth="1"
      strokeLinecap="round"
    />
    <path d="M6.8 13 C9.2 14, 14.8 14, 17.2 13" className="stroke-amber-800/55" strokeWidth="0.9" />
    <ellipse
      cx="12"
      cy="6.5"
      rx="5.5"
      ry="2.3"
      className="fill-amber-200 dark:fill-amber-300/85 stroke-amber-700 dark:stroke-amber-400"
      strokeWidth="1.3"
    />
    <ellipse cx="12" cy="6.5" rx="2.6" ry="1.1" className="fill-amber-950/85 dark:fill-slate-950" />
  </svg>
);

/** Flat metallic washer ring for Bought Parts. */
export const WasherIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <defs>
      <linearGradient id="tile-part-washer-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#f8fafc" />
        <stop offset="50%" stopColor="#cbd5e1" />
        <stop offset="100%" stopColor="#64748b" />
      </linearGradient>
    </defs>
    <ellipse cx="12" cy="20" rx="8" ry="1.4" className="fill-slate-900/12 dark:fill-black/35" />
    {/* Washer thickness rim */}
    <path
      d="M3.5 11.5 V14 C3.5 16.8 7.3 19 12 19 C16.7 19 20.5 16.8 20.5 14 V11.5"
      className="fill-slate-500 dark:fill-slate-600 stroke-slate-600 dark:stroke-slate-300"
      strokeWidth="1.2"
    />
    {/* Top metallic ring face */}
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 6.5 C7.3 6.5 3.5 8.7 3.5 11.5 C3.5 14.3 7.3 16.5 12 16.5 C16.7 16.5 20.5 14.3 20.5 11.5 C20.5 8.7 16.7 6.5 12 6.5 Z M12 9.4 C9.8 9.4 8 10.3 8 11.5 C8 12.7 9.8 13.6 12 13.6 C14.2 13.6 16 12.7 16 11.5 C16 10.3 14.2 9.4 12 9.4 Z"
      fill="url(#tile-part-washer-grad)"
      className="stroke-slate-600 dark:stroke-slate-300"
      strokeWidth="1.2"
    />
  </svg>
);

/** Recessed circular magnet pocket with drop-in arrow indicator for Cuts. */
export const MagnetPocketIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <ellipse cx="12" cy="21" rx="8" ry="1.4" className="fill-rose-900/12 dark:fill-black/35" />
    {/* Part block with recessed pocket */}
    <rect x="3" y="10.5" width="18" height="9.5" rx="2" className="fill-rose-100 dark:fill-rose-950/50 stroke-rose-500 dark:stroke-rose-400" strokeWidth="1.2" />
    <ellipse cx="12" cy="14" rx="5.8" ry="2.6" className="fill-rose-900/80 dark:fill-slate-950 stroke-rose-600 dark:stroke-rose-400" strokeWidth="1.1" />
    {/* Magnet disc & drop-in arrow above */}
    <path d="M12 2.5 V9 M9.8 7 L12 9.4 L14.2 7" className="stroke-rose-600 dark:stroke-rose-400" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    <ellipse cx="12" cy="14.5" rx="3.4" ry="1.3" className="fill-slate-300 dark:fill-slate-400 stroke-slate-600" strokeWidth="0.8" />
  </svg>
);

/** Metallic disc magnet with N/S red/silver accent for Bought Parts. */
export const MagnetIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <defs>
      <linearGradient id="tile-part-magnet-grad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#f1f5f9" />
        <stop offset="45%" stopColor="#cbd5e1" />
        <stop offset="100%" stopColor="#64748b" />
      </linearGradient>
    </defs>
    <ellipse cx="12" cy="20.5" rx="7.5" ry="1.4" className="fill-slate-900/15 dark:fill-black/35" />
    {/* Lower S-pole silver half */}
    <path
      d="M4.5 13 V16 C4.5 18 7.86 19.5 12 19.5 C16.14 19.5 19.5 18 19.5 16 V13"
      fill="url(#tile-part-magnet-grad)"
      className="stroke-slate-600 dark:stroke-slate-300"
      strokeWidth="1.2"
    />
    {/* Upper N-pole red half */}
    <path
      d="M4.5 9 V13 C4.5 15 7.86 16.5 12 16.5 C16.14 16.5 19.5 15 19.5 13 V9"
      className="fill-rose-500 dark:fill-rose-600 stroke-rose-700 dark:stroke-rose-400"
      strokeWidth="1.2"
    />
    <ellipse
      cx="12"
      cy="9"
      rx="7.5"
      ry="3.2"
      className="fill-rose-300 dark:fill-rose-400/85 stroke-rose-700 dark:stroke-rose-300"
      strokeWidth="1.2"
    />
    <path d="M9.5 8.8 H14.5" className="stroke-white/80" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

/** Two-leaf print-in-place knuckle hinge for Printed Hardware. */
export const HingeIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <defs>
      <linearGradient id="tile-hinge-pin-grad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#bae6fd" />
        <stop offset="50%" stopColor="#38bdf8" />
        <stop offset="100%" stopColor="#0369a1" />
      </linearGradient>
    </defs>
    {/* Left leaf */}
    <rect x="2.5" y="5" width="7.5" height="14" rx="1.2" className="fill-sky-200 dark:fill-sky-400/40 stroke-sky-600 dark:stroke-sky-400" strokeWidth="1.2" />
    {/* Right leaf */}
    <rect x="14" y="5" width="7.5" height="14" rx="1.2" className="fill-sky-300 dark:fill-sky-500/50 stroke-sky-600 dark:stroke-sky-400" strokeWidth="1.2" />
    {/* Screw holes on leaves */}
    <circle cx="6" cy="8.5" r="1.1" className="fill-sky-700/70 dark:fill-slate-950" />
    <circle cx="6" cy="15.5" r="1.1" className="fill-sky-700/70 dark:fill-slate-950" />
    <circle cx="18" cy="8.5" r="1.1" className="fill-sky-700/70 dark:fill-slate-950" />
    <circle cx="18" cy="15.5" r="1.1" className="fill-sky-700/70 dark:fill-slate-950" />
    {/* Interleaved knuckle barrel along center */}
    <rect x="10" y="3.5" width="4" height="17" rx="1.6" fill="url(#tile-hinge-pin-grad)" className="stroke-sky-700 dark:stroke-sky-300" strokeWidth="1.2" />
    <path d="M10.2 7.5 H13.8 M10.2 11.5 H13.8 M10.2 15.5 H13.8" className="stroke-sky-900/65 dark:stroke-slate-950" strokeWidth="1" />
  </svg>
);

/** Tall cylindrical PCB mounting standoff post with bore for Cuts. */
export const StandoffIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <defs>
      <linearGradient id="tile-cut-standoff-grad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#99f6e4" />
        <stop offset="40%" stopColor="#5eead4" />
        <stop offset="100%" stopColor="#0f766e" />
      </linearGradient>
    </defs>
    {/* Base flange / PCB pad */}
    <ellipse cx="12" cy="19.2" rx="8" ry="2.4" className="fill-teal-200 dark:fill-teal-800/70 stroke-teal-600 dark:stroke-teal-400" strokeWidth="1.2" />
    {/* Tall standoff post */}
    <path
      d="M7.5 5.5 V18.5 C7.5 19.8 9.5 20.6 12 20.6 C14.5 20.6 16.5 19.8 16.5 18.5 V5.5"
      fill="url(#tile-cut-standoff-grad)"
      className="stroke-teal-600 dark:stroke-teal-400"
      strokeWidth="1.3"
    />
    <ellipse
      cx="12"
      cy="5.5"
      rx="4.5"
      ry="2"
      className="fill-teal-100 dark:fill-teal-200/85 stroke-teal-600 dark:stroke-teal-400"
      strokeWidth="1.3"
    />
    {/* Center mounting bore */}
    <ellipse cx="12" cy="5.5" rx="2" ry="0.9" className="fill-teal-950/85 dark:fill-slate-950" />
  </svg>
);

/** Circular hole with helical thread lines for Cuts. */
export const ThreadedHoleIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <rect x="3" y="3" width="18" height="18" rx="3" className="fill-sky-100 dark:fill-sky-950/50 stroke-sky-500 dark:stroke-sky-400" strokeWidth="1.2" />
    {/* Outer minor/major thread ring (dashed) */}
    <circle
      cx="12"
      cy="12"
      r="6.6"
      className="stroke-sky-600 dark:stroke-sky-300"
      strokeWidth="1.2"
      strokeDasharray="2.4 1.6"
    />
    {/* Inner tapped bore with helical thread arcs */}
    <circle cx="12" cy="12" r="4.6" className="fill-sky-900/85 dark:fill-slate-950 stroke-sky-600 dark:stroke-sky-400" strokeWidth="1.2" />
    <path
      d="M8.5 10.5 C10.2 9.4, 13.8 9.4, 15.5 10.5 M8.3 12.6 C10.2 11.5, 13.8 11.5, 15.7 12.6 M9 14.5 C10.6 13.7, 13.4 13.7, 15 14.5"
      className="stroke-sky-300/85 dark:stroke-sky-400/80"
      strokeWidth="1"
      strokeLinecap="round"
    />
  </svg>
);
