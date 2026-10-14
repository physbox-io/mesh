// The studio backdrop's colour stops, kept out of StudioBackdrop.tsx so that
// module exports only its component (fast refresh needs that) and the stops
// can be tested without a renderer.

export interface CycloramaPalette {
  top: string;
  horizon: string;
  bottom: string;
  spotCenter: string;
  spotInner: string;
  spotEdge: string;
  spotCorner: string;
}

export function getCycloramaPalette(darkMode: boolean): CycloramaPalette {
  if (darkMode) {
    return {
      top: '#070b14',
      horizon: '#111b2e',
      bottom: '#060911',
      spotCenter: '#213252',
      spotInner: '#152038',
      spotEdge: '#090e1a',
      spotCorner: '#03060c',
    };
  }

  return {
    top: '#eaeff6',
    horizon: '#fafbfd',
    bottom: '#e4ebf4',
    spotCenter: '#fffdfa',
    spotInner: '#f8fafd',
    spotEdge: '#e8eef6',
    spotCorner: '#d8e2ef',
  };
}
