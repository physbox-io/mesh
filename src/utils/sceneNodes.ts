// Normalisation and merging of scene nodes returned by the copilot LLM.
//
// These were closures inside AICopilotPanel, which made them untestable: they
// only ever closed over `sceneGraph.nodes`, so they are pure functions once that
// is passed in explicitly. They are the last line of defence between a model's
// JSON and the store, and several silent scene-corruption bugs lived here.

const randomSuffix = (len: number) => Math.random().toString(36).substring(2, 2 + len);

/**
 * Fills in defaults and repairs a raw node array from the LLM, resolving each
 * field against the matching node already in the scene so a model that restates
 * only what it changed doesn't blank out everything it left out.
 */
export function sanitizeAndNormalizeNodes(rawNodes: any[], existingNodes: any[] = []): any[] {
  if (!Array.isArray(rawNodes)) return [];

  const usedBodyNames = new Set<string>();
  const usedGeomNames = new Set<string>();

  const existingNodeMap = new Map<string, any>();
  const collectExisting = (list: any[]) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item.id) existingNodeMap.set(item.id, item);
      if (item.name) existingNodeMap.set(item.name, item);
      if (item.children) collectExisting(item.children);
    }
  };
  collectExisting(existingNodes);

  const normalizeNode = (n: any, idx: number): any => {
    if (!n || typeof n !== 'object') return null;

    const baseId = n.id || `node_${Date.now()}_${idx}_${randomSuffix(4)}`;
    let baseName = n.name || baseId;

    if (usedBodyNames.has(baseName)) {
      baseName = `${baseName}_${randomSuffix(4)}`;
    }
    usedBodyNames.add(baseName);

    const existingNode = existingNodeMap.get(baseId) || existingNodeMap.get(baseName);
    const scadScript = n.scad !== undefined ? n.scad : existingNode?.scad;

    // An omitted pos falls back to the existing node here. There used to be a
    // second guard below this that ALSO reverted an all-zero pos to the existing
    // one - but omission is already handled by this ternary, so that guard could
    // only ever fire when the model deliberately sent [0,0,0]. It silently undid
    // every "move it to the origin" / "drop it to the floor" / "centre it"
    // request while the chat still reported success. Do not reintroduce it: an
    // explicit zero is a real instruction.
    const pos = Array.isArray(n.pos) && n.pos.length === 3
      ? n.pos.map((v: any) => typeof v === 'number' ? v : 0)
      : (existingNode?.pos || [0, 0, 0]);

    const euler = Array.isArray(n.euler) && n.euler.length === 3
      ? n.euler.map((v: any) => typeof v === 'number' ? v : 0)
      : (existingNode?.euler || [0, 0, 0]);

    const geoms = Array.isArray(n.geoms) && n.geoms.length > 0 ? n.geoms.map((g: any, gIdx: number) => {
      let gName = g.name || `${baseName}_geom_${gIdx}`;
      if (usedGeomNames.has(gName)) {
        gName = `${gName}_${randomSuffix(4)}`;
      }
      usedGeomNames.add(gName);

      const existingGeom = existingNode?.geoms?.[gIdx];
      const vertices = g.vertices || existingGeom?.vertices;
      const faces = g.faces || existingGeom?.faces;
      const renderVertices = g.renderVertices || existingGeom?.renderVertices;

      const hasMeshData = Array.isArray(vertices) && vertices.length > 0 && Array.isArray(faces) && faces.length > 0;
      let gType = g.type || existingGeom?.type || (scadScript || hasMeshData ? 'mesh' : 'box');
      if (gType === 'mesh' && !hasMeshData) {
        gType = 'box';
      }

      // size resolves against the existing geom like every other field here. It
      // used to fall straight through to [0.1, 0.1, 0.1] when the model didn't
      // restate it, silently resizing any primitive the model merely mentioned.
      const sourceSize = Array.isArray(g.size) && g.size.length > 0
        ? g.size
        : (Array.isArray(existingGeom?.size) && existingGeom.size.length > 0 ? existingGeom.size : null);

      let rawSize = sourceSize
        ? sourceSize.map((v: any) => typeof v === 'number' && !isNaN(v) && v > 0 ? v : 0.1)
        : [0.1, 0.1, 0.1];

      if (gType === 'box' && rawSize.length < 3) {
        rawSize = [rawSize[0] || 0.1, rawSize[1] || rawSize[0] || 0.1, rawSize[2] || rawSize[0] || 0.1];
      }
      // A capsule/cylinder needs [radius, half_length]; a 1-element size does not
      // error, it falls back to half_length = radius in the MJCF writer and
      // collapses the geom into a stub pill at its pos. Only fill this in when
      // there is no fromto, which specifies the span directly.
      if ((gType === 'capsule' || gType === 'cylinder') && rawSize.length < 2 && !Array.isArray(g.fromto)) {
        rawSize = [rawSize[0] || 0.1, rawSize[0] || 0.1];
      }

      const isDynamic = g.dynamic !== undefined
        ? g.dynamic
        : (existingGeom?.dynamic !== undefined ? existingGeom.dynamic : (scadScript || hasMeshData ? true : false));

      // Carry over fields this normaliser has no opinion on - fromto, contype,
      // conaffinity, condim, friction, solref, csg - from the geom already in
      // the scene, then let anything the model restated win. The old version
      // built a fixed object literal and dropped every one of them, so a mutate
      // that merely mentioned a geom silently deleted its span and its collision
      // filtering (the very thing the copilot's own system prompt tells the model
      // to preserve). Extras are only inherited when the type is unchanged: a
      // fromto inherited onto a geom the model just turned into a box would
      // override the size it asked for.
      const inherited = existingGeom && (g.type === undefined || g.type === existingGeom.type)
        ? existingGeom
        : {};

      return {
        ...inherited,
        ...g,
        id: g.id || existingGeom?.id || `geom_${randomSuffix(6)}`,
        name: gName,
        type: gType,
        size: rawSize,
        pos: Array.isArray(g.pos) ? g.pos : (existingGeom?.pos || [0, 0, 0]),
        rgba: Array.isArray(g.rgba) && g.rgba.length === 4 ? g.rgba : (existingGeom?.rgba || [0.6, 0.6, 0.9, 1]),
        mass: typeof g.mass === 'number' ? g.mass : (existingGeom?.mass ?? 1.0),
        dynamic: isDynamic,
        vertices,
        faces,
        renderVertices,
      };
    }) : (existingNode?.geoms ? [...existingNode.geoms] : []);

    if (scadScript && geoms.length === 0) {
      geoms.push({
        id: `geom_${randomSuffix(6)}`,
        name: `${baseName}_scad_mesh`,
        type: 'mesh',
        size: [0.1, 0.1, 0.1],
        pos: [0, 0, 0],
        rgba: [0.6, 0.6, 0.9, 1],
        mass: 1.0,
        dynamic: true
      });
    }

    const joints = Array.isArray(n.joints) ? n.joints.map((j: any, jIdx: number) => ({
      id: j.id || `joint_${randomSuffix(6)}`,
      name: j.name || `${baseName}_joint_${jIdx}`,
      type: j.type || 'hinge',
      axis: Array.isArray(j.axis) ? j.axis : [0, 0, 1],
      pos: Array.isArray(j.pos) ? j.pos : [0, 0, 0],
      damping: typeof j.damping === 'number' ? j.damping : 0.1,
      stiffness: typeof j.stiffness === 'number' ? j.stiffness : 0.0,
      actuator: j.actuator,
    })) : (existingNode?.joints || []);

    const children = Array.isArray(n.children)
      ? n.children.map((c: any, cIdx: number) => normalizeNode(c, cIdx)).filter(Boolean)
      : [];

    return {
      ...n,
      id: baseId,
      name: baseName,
      pos,
      euler,
      geoms,
      joints,
      children,
      ...(scadScript ? { scad: scadScript } : {}),
    };
  };

  return rawNodes.map((n, idx) => normalizeNode(n, idx)).filter(Boolean);
}

/**
 * Merges normalised LLM nodes over the current scene. `isFullReplacement` (the
 * generate path) discards the current scene entirely; otherwise every node the
 * model didn't mention is carried through untouched.
 */
export function mergeAndNormalizeNodes(
  rawNodes: any[],
  existingNodes: any[] = [],
  isFullReplacement: boolean = false
): any[] {
  const normalizedRaw = sanitizeAndNormalizeNodes(rawNodes, existingNodes);

  if (isFullReplacement || !existingNodes || existingNodes.length === 0) {
    return normalizedRaw;
  }

  const resultMap = new Map<string, any>();
  existingNodes.forEach((node, index) => {
    const key = node.id || node.name || `node_${index}`;
    resultMap.set(key, JSON.parse(JSON.stringify(node)));
  });

  normalizedRaw.forEach((newNode: any, idx: number) => {
    let matchedKey: string | null = null;

    for (const [k, existing] of resultMap.entries()) {
      if (k === newNode.id || k === newNode.name || existing.name === newNode.name || existing.id === newNode.id) {
        matchedKey = k;
        break;
      }
    }

    // There used to be a positional fallback here: an unmatched node was merged
    // onto whatever existing node sat at the same index. That is only correct
    // when the model restated the whole scene in order - when it returned just
    // the one body it added (against instructions, but it happens), the new body
    // was merged ONTO the first existing body instead of appended, corrupting a
    // node the user never asked to touch. An id/name that matches nothing now
    // means what it says: a new body.

    if (matchedKey && resultMap.has(matchedKey)) {
      const existingNode = resultMap.get(matchedKey);

      const mergedGeoms = (newNode.geoms && newNode.geoms.length > 0)
        ? newNode.geoms.map((g: any, gIdx: number) => {
            const existingG = existingNode.geoms?.[gIdx];
            const vertices = g.vertices || existingG?.vertices;
            const faces = g.faces || existingG?.faces;
            const renderVertices = g.renderVertices || existingG?.renderVertices;
            const hasMesh = Array.isArray(vertices) && vertices.length > 0 && Array.isArray(faces) && faces.length > 0;
            const scadScript = newNode.scad !== undefined ? newNode.scad : existingNode.scad;

            return {
              ...g,
              type: g.type === 'box' && hasMesh ? 'mesh' : g.type,
              dynamic: g.dynamic !== undefined ? g.dynamic : (existingG?.dynamic !== undefined ? existingG.dynamic : (scadScript || hasMesh ? true : false)),
              vertices,
              faces,
              renderVertices,
            };
          })
        : existingNode.geoms;

      resultMap.set(matchedKey, {
        ...existingNode,
        ...newNode,
        id: existingNode.id,
        name: newNode.name || existingNode.name,
        scad: newNode.scad !== undefined ? newNode.scad : existingNode.scad,
        geoms: mergedGeoms,
        joints: (newNode.joints && newNode.joints.length > 0) ? newNode.joints : existingNode.joints,
        children: (newNode.children && newNode.children.length > 0) ? newNode.children : existingNode.children,
      });
    } else {
      const key = newNode.id || newNode.name || `node_${Date.now()}_${idx}`;
      resultMap.set(key, newNode);
    }
  });

  const finalNodes = Array.from(resultMap.values());

  for (const originalNode of existingNodes) {
    const exists = finalNodes.some(fn => fn.id === originalNode.id || fn.name === originalNode.name);
    if (!exists) {
      finalNodes.push(JSON.parse(JSON.stringify(originalNode)));
    }
  }

  return finalNodes;
}
