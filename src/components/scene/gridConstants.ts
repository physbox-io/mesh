/*
 * 4 viewing distances out, with fadeStrength 0.8 on the Grid in App.tsx. Between the
 * two numbers: the ground is at about 79% alpha where the part is standing,
 * half gone a bit over two windows out and finished at four. 8 and 0.5 left it
 * at 94% at the part and running to the horizon, which read as no fog at all.
 */
export const GRID_FADE_RATIO = 4;

/** What the grid mesh is called in the scene, so GridFadeFollowsCamera can find it. */
export const GRID_NAME = 'ground-grid';
