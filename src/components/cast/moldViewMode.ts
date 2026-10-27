// The Rigid tab's preview views, kept apart from the view component for fast refresh.

export type PreviewViewMode = 'clamshell_exploded' | 'plate' | 'bottom_only' | 'top_only' | 'cast_preview';

/** The view asked for, or the plate where an open mold has no lid to show. */
export function effectiveMoldView(moldType: 'clamshell' | 'open', viewMode: PreviewViewMode): PreviewViewMode {
  return moldType === 'open' && (viewMode === 'clamshell_exploded' || viewMode === 'top_only') ? 'plate' : viewMode;
}
