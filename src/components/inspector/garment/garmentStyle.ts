// Styles and colour helpers the garment cards share (garmentUi.tsx holds the controls).

export const labelCls = 'text-xs text-slate-500 dark:text-slate-400 font-medium';
export const selectCls = 'w-full text-xs border border-slate-200 dark:border-slate-700 rounded-md px-1.5 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 cursor-pointer';
export const cardCls = 'flex flex-col gap-2.5 p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 rounded-lg';
export const smallButtonCls = 'text-[11px] font-semibold px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer';
export const removeCls = 'text-slate-400 dark:text-slate-500 hover:text-red-600 dark:hover:text-red-400 cursor-pointer px-1';
export const hex = (rgba: number[]) => `#${rgba.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
export const rgbaOf = (h: string, a: number) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(a);
