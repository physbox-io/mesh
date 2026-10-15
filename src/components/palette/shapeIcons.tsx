// The palette's part tiles, drawn as small isometric SVGs. Gradient ids are
// global to the page, so each one is prefixed `tile-` and used once.

export const CubeIcon = () => (
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
);

export const SphereIcon = () => (
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
);

export const CylinderIcon = () => (
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
);

export const PoleIcon = () => (
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
);

export const GearIcon = () => (
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
);

export const WedgeIcon = () => (
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
);

export const PyramidIcon = () => (
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
);

export const ConeIcon = () => (
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
);

export const TorusIcon = () => (
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
);

export const TubeIcon = () => (
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
);

export const EllipsoidIcon = () => (
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
);

export const RingIcon = () => (
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
);

export const SculptIcon = () => (
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
);

export const LatticeIcon = () => (
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
);

export const CurveIcon = () => (
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
);

export const PulleyIcon = () => (
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
);

export const RopeIcon = () => (
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
);

export const MeshIcon = () => (
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
);

export const ScadIcon = () => (
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
);
