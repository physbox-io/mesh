// ---------------------------------------------------------------------------
// The frame every mold and cast panel is drawn in
// ---------------------------------------------------------------------------
//
// A panel is the body of a dialog and its footer, and nothing else: the
// overlay, the header and the close button are here, so the four kinds of
// mold can share one dialog and swap panels under one row of tabs.

import React from 'react';
import { X } from 'lucide-react';

export function CastDialogFrame({
  icon, iconClass, title, subtitle, onClose, width = 'max-w-5xl', tabs, children,
}: {
  icon: React.ReactNode;
  /** The icon tile's background. */
  iconClass: string;
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  width?: string;
  /** Drawn under the header, above the panel. */
  tabs?: React.ReactNode;
  /** A PanelBody and a PanelFooter. */
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className={`bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full ${width} max-h-[95dvh] flex flex-col overflow-hidden text-slate-800 dark:text-slate-100`}>
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-9 h-9 shrink-0 rounded-xl flex items-center justify-center text-white shadow-md ${iconClass}`}>
              {icon}
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-base">{title}</h3>
              {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{subtitle}</p>}
            </div>
          </div>
          <button
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {tabs}
        {children}
      </div>
    </div>
  );
}

/** The scrolling part of a panel. */
export function PanelBody({ className = 'p-6 space-y-3 text-sm', children }: { className?: string; children: React.ReactNode }) {
  return <div className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden ${className}`}>{children}</div>;
}

/** The row of actions under a panel. */
export function PanelFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
      {children}
    </div>
  );
}
