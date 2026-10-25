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
