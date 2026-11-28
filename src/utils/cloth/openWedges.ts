/**
 * Where a garment is cut open (a jacket's front, a vent), the points along the
 * cut belong to the cloth on each side of it separately. Round each such point
 * its triangles fall into wedges, parted by the open seam edges that meet
 * there and joined across every closed one: at a T where a yoke crosses a
 * jacket's front, the two right panels are one wedge and the two left panels
 * the other, however the panels are ordered. Any number of panels and cuts may
 * meet at a point.
 */

export interface OpenWedges {
  /** For each open point, the wedge each panel touching it is in (panel index -> wedge). */
  wedgeOf: Map<number, Map<number, number>>;
  /** For each open point, the wedges facing each other across one of its open edges (each pair once). */
  across: Map<number, [number, number][]>;
  /**
   * For each open point, the wedge each triangle round it is in (shell
   * triangle index -> wedge): a cut that ends inside one panel (a slit) has
   * that panel on both its sides, so its points are split by triangle.
   */
  wedgeOfTri: Map<number, Map<number, number>>;
}

export function openWedges(shell: { tris: number[]; seams: { path: number[]; open?: boolean }[]; panels: { tris: number[] }[] }): OpenWedges {
  const openEdge = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const openPoints = new Set<number>();
  for (const sm of shell.seams) {
    if (!sm.open) continue;
    for (let i = 0; i + 1 < sm.path.length; i++) openEdge.add(key(sm.path[i], sm.path[i + 1]));
    for (const p of sm.path) openPoints.add(p);
  }
  const wedgeOf = new Map<number, Map<number, number>>(), across = new Map<number, [number, number][]>(), wedgeOfTri = new Map<number, Map<number, number>>();
  if (!openPoints.size) return { wedgeOf, across, wedgeOfTri };
  const panelOfTri = new Int32Array(shell.tris.length / 3).fill(-1);
  shell.panels.forEach((pn, k) => { for (const t of pn.tris) panelOfTri[t] = k; });
  const around = new Map<number, number[]>();
  for (let t = 0; t < shell.tris.length / 3; t++) for (let c = 0; c < 3; c++) {
    const g = shell.tris[3 * t + c];
    if (openPoints.has(g)) (around.get(g) ?? around.set(g, []).get(g)!).push(t);
  }
  for (const [g, ts] of around) {
    // Union the triangles round g that share an edge from g which is not cut open.
    const parent = ts.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const byOther = new Map<number, number[]>();
    ts.forEach((t, i) => { for (let c = 0; c < 3; c++) { const v = shell.tris[3 * t + c]; if (v !== g) (byOther.get(v) ?? byOther.set(v, []).get(v)!).push(i); } });
    const cuts: number[][] = [];
    for (const [v, list] of byOther) {
      if (list.length < 2) continue;
      if (openEdge.has(key(g, v))) { cuts.push(list); continue; }
      for (let i = 1; i < list.length; i++) parent[find(list[i])] = find(list[0]);
    }
    // Wedges numbered in the order their triangles come; each panel in the wedge most of its triangles here are in.
    const wedgeIdx = new Map<number, number>();
    const wedgeOfTri_ = ts.map((_, i) => { const r = find(i); if (!wedgeIdx.has(r)) wedgeIdx.set(r, wedgeIdx.size); return wedgeIdx.get(r)!; });
    const votes = new Map<number, Map<number, number>>();
    ts.forEach((t, i) => { const k = panelOfTri[t]; if (k < 0) return; const m = votes.get(k) ?? votes.set(k, new Map()).get(k)!; m.set(wedgeOfTri_[i], (m.get(wedgeOfTri_[i]) ?? 0) + 1); });
    const panels = new Map<number, number>();
    for (const [k, m] of votes) panels.set(k, [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]);
    wedgeOf.set(g, panels);
    wedgeOfTri.set(g, new Map(ts.map((t, i) => [t, wedgeOfTri_[i]])));
    const pairs: [number, number][] = [], seen = new Set<string>();
    for (const list of cuts) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = wedgeOfTri_[list[i]], b = wedgeOfTri_[list[j]];
      if (a === b || seen.has(key(a, b))) continue;
      seen.add(key(a, b));
      pairs.push(a < b ? [a, b] : [b, a]);
    }
    across.set(g, pairs);
  }
  return { wedgeOf, across, wedgeOfTri };
}

/**
 * The wedge each of a piece's points is in at an open point (-1 elsewhere):
 * by the shell triangle one of its own triangles is (a piece cut from the
 * shell has a point per side of a slit inside it, each in triangles on its
 * own side), else by the panel's wedge (a piece meshed afresh).
 */
export function pieceWedges(w: OpenWedges, shellTris: number[], piece: { points: number[]; tris: number[] }, panel: number): number[] {
  const out = piece.points.map((g) => (w.wedgeOf.has(g) ? w.wedgeOf.get(g)!.get(panel) ?? 0 : -1));
  const done = new Set<number>();
  for (let t = 0; t < piece.tris.length; t += 3) for (let c = 0; c < 3; c++) {
    const l = piece.tris[t + c], g = piece.points[l];
    if (done.has(l) || !w.wedgeOfTri.has(g)) continue;
    const others = [piece.points[piece.tris[t + ((c + 1) % 3)]], piece.points[piece.tris[t + ((c + 2) % 3)]]];
    if (others.some((q) => q < 0)) continue;
    for (const [st, wedge] of w.wedgeOfTri.get(g)!) {
      const v = [shellTris[3 * st], shellTris[3 * st + 1], shellTris[3 * st + 2]];
      if (others.every((q) => v.includes(q))) { out[l] = wedge; done.add(l); break; }
    }
  }
  return out;
}
