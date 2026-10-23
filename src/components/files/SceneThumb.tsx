/** A saved scene's picture from its last save, or `fallback` for a scene saved before they were kept. */
export function SceneThumb({ url, fallback, className }: { url: string | null; fallback: React.ReactNode; className: string }) {
  return (
    <div className={`overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center ${className}`}>
      {url ? <img src={url} alt="" className="w-full h-full object-cover" draggable={false} /> : fallback}
    </div>
  );
}
