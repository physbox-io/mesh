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
  const wedgeOf = new Map<number, Map<number, number>>(), across = new Map<number, [number, number][]>();
  if (!openPoints.size) return { wedgeOf, across };
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
    const wedgeOfTri = ts.map((_, i) => { const r = find(i); if (!wedgeIdx.has(r)) wedgeIdx.set(r, wedgeIdx.size); return wedgeIdx.get(r)!; });
    const votes = new Map<number, Map<number, number>>();
    ts.forEach((t, i) => { const k = panelOfTri[t]; if (k < 0) return; const m = votes.get(k) ?? votes.set(k, new Map()).get(k)!; m.set(wedgeOfTri[i], (m.get(wedgeOfTri[i]) ?? 0) + 1); });
    const panels = new Map<number, number>();
    for (const [k, m] of votes) panels.set(k, [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]);
    wedgeOf.set(g, panels);
    const pairs: [number, number][] = [], seen = new Set<string>();
    for (const list of cuts) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = wedgeOfTri[list[i]], b = wedgeOfTri[list[j]];
      if (a === b || seen.has(key(a, b))) continue;
      seen.add(key(a, b));
      pairs.push(a < b ? [a, b] : [b, a]);
    }
    across.set(g, pairs);
  }
  return { wedgeOf, across };
}
