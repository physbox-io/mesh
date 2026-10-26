/** The mark, wordmark and tagline at the left of the header. */
export function AppLogo() {
  return (
    <div className="flex items-center gap-2">
      <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0 p-1.5">
        <svg viewBox="0 0 512 512" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="logo-cyan-blue" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#00f2fe" />
              <stop offset="100%" stopColor="#3b82f6" />
            </linearGradient>
            <linearGradient id="logo-blue-purple" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#3b82f6" />
              <stop offset="100%" stopColor="#7c3aed" />
            </linearGradient>
            <linearGradient id="logo-face-top" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#00f2fe" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.15" />
            </linearGradient>
            <linearGradient id="logo-face-left" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#1d4ed8" stopOpacity="0.25" />
            </linearGradient>
            <linearGradient id="logo-face-right" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.20" />
              <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.20" />
            </linearGradient>
          </defs>
          <polygon points="256,60 426,158 256,256 86,158" fill="url(#logo-face-top)" />
          <polygon points="86,158 256,256 256,452 86,354" fill="url(#logo-face-left)" />
          <polygon points="256,256 426,158 426,354 256,452" fill="url(#logo-face-right)" />
      
          <g stroke="url(#logo-cyan-blue)" strokeWidth="10" strokeOpacity="0.75" strokeLinecap="round" strokeLinejoin="round">
            <line x1="256" y1="60" x2="256" y2="256" />
            <line x1="86" y1="158" x2="426" y2="158" />
            <line x1="86" y1="158" x2="256" y2="452" />
            <line x1="256" y1="256" x2="86" y2="354" />
            <line x1="256" y1="256" x2="426" y2="354" />
            <line x1="426" y1="158" x2="256" y2="452" />
          </g>
      
          <polygon points="256,60 426,158 426,354 256,452 86,354 86,158" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <line x1="256" y1="256" x2="256" y2="452" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="256" y1="256" x2="86" y2="158" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="256" y1="256" x2="426" y2="158" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
      
          <g fill="#ffffff">
            <circle cx="256" cy="60" r="18" stroke="#7c3aed" strokeWidth="8" />
            <circle cx="86" cy="158" r="18" stroke="#3b82f6" strokeWidth="8" />
            <circle cx="426" cy="158" r="18" stroke="#3b82f6" strokeWidth="8" />
            <circle cx="256" cy="256" r="20" stroke="#3b82f6" strokeWidth="9" />
            <circle cx="86" cy="354" r="18" stroke="#3b82f6" strokeWidth="8" />
            <circle cx="426" cy="354" r="18" stroke="#3b82f6" strokeWidth="8" />
            <circle cx="256" cy="452" r="18" stroke="#7c3aed" strokeWidth="8" />
          </g>
        </svg>
      </div>
      {/* The mark alone identifies the app on a phone; the wordmark and
          tagline are the first thing to give up the width. */}
      <div className="hidden md:block">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-extrabold tracking-tight text-slate-900 dark:text-white font-sans">
            PhysBox: <span className="text-blue-500 dark:text-blue-400 font-normal">Mesh</span>
          </h1>
          <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950/80 border border-blue-200 dark:border-blue-800/50 text-blue-700 dark:text-blue-300">
            3D Studio
          </span>
        </div>
        <p className="text-[10px] text-slate-500 dark:text-slate-400">Real World Physics &amp; Design Studio</p>
      </div>
    </div>
  );
}
