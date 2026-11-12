import { useCallback, useState } from 'react';
import { ChevronRight, ChevronDown, Eye, EyeOff, ListPlus, Trash2 } from 'lucide-react';
import { useStore } from '../store/useStore';
import { usePanels } from '../store/panelsStore';
import { useTreeView } from '../store/treeViewStore';
import { HARDWARE_KINDS } from '../utils/hardwareCuts';
import type { SceneGeom, SceneNode } from '../types/scene';

/** A pretty visual emoji for a body, from what it is or what it is called. */
function nodeEmoji(node: SceneNode): string {
  if (node.id.includes('coin')) return '🪙';
  if (node.id.includes('gear')) return '⚙️';
  if (node.id.includes('pole') || node.id.includes('capsule')) return '🥢';
  if (node.id.includes('bob')) return '🔵';
  if (node.id.includes('cylinder')) return '🛢️';
  if (node.id.includes('sphere')) return '🟢';
  if (node.id.includes('wedge')) return '📐';
  if (node.id.includes('pyramid')) return '🔺';
  if (node.id.includes('cone')) return '🍦';
  if (node.id.includes('torus')) return '🍩';
  if (node.id.includes('tube')) return '🛢️';
  if (node.id.includes('ellipsoid')) return '🥚';
  if (node.id.includes('pulley_wheel')) return '🛞';
  if (node.isPulleyRope) return '🧵';
  if (node.isCurve || node.id.includes('curve')) return '🎢';
  if (node.csgEnabled || node.id.includes('ring')) return '💠';
  return '📦';
}

function geomEmoji(node: SceneNode, g: SceneGeom): string {
  if (g.hardware) return '🔩';
  // A boolean operator matters more than the shape it's applied to.
  if (g.csg === 'difference') return '➖';
  if (g.csg === 'intersection') return '∩';
  if (g.type === 'cylinder') return '🛢️';
  if (g.type === 'box') return '📦';
  if (g.type === 'sphere') return '🟢';
  if (g.type === 'ellipsoid') return '🥚';
  if (g.type === 'mesh') {
    if (node.isPyramid) return '🔺';
    if (node.isCone) return '🍦';
    if (node.isTorus) return '🍩';
    if (node.isTube) return '🛢️';
    return '📐';
  }
  return '🔹';
}

/**
 * Whether a geom gets a row of its own: not a boolean's output, not a
 * generated collider, and not a builder's part unless those are being shown.
 */
function listsGeom(g: SceneGeom, showInternal: boolean): boolean {
  return !g.csgDerived && g.role !== 'collision' && (showInternal || !g.internal);
}

function countInternal(nodes: SceneNode[]): number {
  let n = 0;
  for (const node of nodes) n += (node.geoms ?? []).filter((g) => g.internal && listsGeom(g, true)).length + countInternal(node.children ?? []);
  return n;
}

/** Picking a row selects it and, as an overlay on a phone, gets the drawer out of the way. */
function useSelectRow() {
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);
  const setActiveGeomIndex = useStore((s) => s.setActiveGeomIndex);
  const setLeftSidebarOpen = usePanels((s) => s.setLeftSidebarOpen);
  return useCallback((id: string | null, geomIndex?: number) => {
    setSelectedNodeId(id);
    // A body row picks the body (its first shape in the inspector, the whole
    // body outlined); a geom row picks that geom, and only it is outlined.
    if (id) setActiveGeomIndex(geomIndex ?? 0, geomIndex !== undefined);
    setLeftSidebarOpen(false);
  }, [setSelectedNodeId, setActiveGeomIndex, setLeftSidebarOpen]);
}

interface HierarchyRowProps {
  node: SceneNode;
  depth: number;
  /** A child of a hidden body is not drawn either, so it reads as hidden too. */
  ancestorHidden: boolean;
  collapsedIds: Set<string>;
  onToggleCollapsed: (id: string) => void;
}

/**
 * One body, its geoms when it has several, and its children. Each row reads
 * only its own selection and visibility, so picking a body re-renders the two
 * rows that changed rather than the whole tree.
 */
function HierarchyRow({ node, depth, ancestorHidden, collapsedIds, onToggleCollapsed }: HierarchyRowProps) {
  const isSelected = useStore((s) => s.selectedNodeId === node.id);
  // -1 unless one of this body's geoms was picked on its own.
  const activeGeomIndex = useStore((s) => (s.selectedNodeId === node.id && s.geomFocused ? s.activeGeomIndex : -1));
  const isHidden = useStore((s) => s.hiddenNodeIds.includes(node.id));
  const toggleNodeHidden = useStore((s) => s.toggleNodeHidden);
  const deleteNodeGeom = useStore((s) => s.deleteNodeGeom);
  const setActiveGeomIndex = useStore((s) => s.setActiveGeomIndex);
  const updateNodeGeom = useStore((s) => s.updateNodeGeom);
  const showInternal = useTreeView((s) => s.showInternalParts);
  const select = useSelectRow();

  const dimmed = isHidden || ancestorHidden;
  const userGeoms = node.geoms?.filter((g) => listsGeom(g, showInternal)) ?? [];
  const showGeoms = userGeoms.length > 1 && !node.isCurve;
  const hasChildren = !!node.children && node.children.length > 0;
  const collapsible = showGeoms || hasChildren;
  const isCollapsed = collapsible && collapsedIds.has(node.id);

  return (
    <div className="flex flex-col">
      <div
        onClick={() => select(node.id)}
        style={{ paddingLeft: `${depth === 0 ? 8 : 4}px` }}
        className={`flex items-center px-2 py-1.5 rounded-md border cursor-pointer transition-colors shadow-sm mb-1 ${
          isSelected && activeGeomIndex === -1
            ? 'bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-400 font-semibold'
            : isSelected
              ? 'bg-blue-50/40 border-blue-100/50 text-blue-500 dark:bg-blue-950/20 dark:border-blue-900/50 dark:text-blue-400 font-semibold'
              : 'bg-white dark:bg-slate-900/90 border-transparent dark:border-slate-800/40 hover:bg-slate-100/70 dark:hover:bg-slate-800/70 text-slate-600 dark:text-slate-300'
        }`}
      >
        {collapsible ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleCollapsed(node.id); }}
            className="-ml-1 mr-0.5 p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 cursor-pointer shrink-0"
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        ) : (
          <span className="-ml-1 mr-0.5 w-4 shrink-0" />
        )}
        <span className={`text-xs flex items-center gap-1.5 font-medium truncate min-w-0 ${dimmed ? 'opacity-50' : ''}`}>
          <span>{nodeEmoji(node)}</span> <span className="truncate">{node.name}</span>
        </span>
        {/* View only: a hidden body still collides and has mass. */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleNodeHidden(node.id); }}
          className={`ml-auto pl-1 p-0.5 rounded cursor-pointer shrink-0 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 ${
            isHidden ? 'text-slate-400 dark:text-slate-500' : 'text-slate-400/70 hover:text-slate-600 dark:hover:text-slate-200'
          }`}
          title={isHidden ? 'Show' : 'Hide in the view (still collides)'}
        >
          {isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Render sub-geoms nested under body if there are multiple geoms.
          Curves are one logical shape built from dozens of segment boxes —
          listing each segment would swamp the tree, so skip them. */}
      {showGeoms && !isCollapsed && (
        <div className="pl-3 ml-2.5 border-l border-slate-200 dark:border-slate-800/60 flex flex-col gap-0.5 mb-1">
          {node.geoms.map((g, idx) => {
            // A hardware feature is several cuts; it is listed once, by what
            // it is, and picking it picks the whole feature for G and S.
            const hw = g.hardware;
            if (hw && node.geoms.findIndex((o) => o.hardware?.group === hw.group && !o.csgDerived) !== idx) return null;
            const isGeomSelected = isSelected && (activeGeomIndex === idx
              || (!!hw && node.geoms[activeGeomIndex]?.hardware?.group === hw.group));
            // Generated boolean output is derived data, not something to select
            // and edit — the primitives above it are the real controls.
            if (!listsGeom(g, showInternal)) return null;

            const hwGroup = hw?.group;
            const canDeleteSubGeom = node.geoms.filter(
              (o, oIdx) => oIdx !== idx && !(hwGroup && o.hardware?.group === hwGroup) && !o.csgDerived && o.csg !== 'difference',
            ).length >= 1;

            return (
              <div
                key={`${node.id}-geom-${idx}`}
                onClick={() => select(node.id, idx)}
                className={`group flex items-center px-2 py-1 rounded-md border cursor-pointer transition-colors shadow-sm text-xs ${
                  isGeomSelected
                    ? 'bg-indigo-50 border-indigo-200 text-indigo-600 dark:bg-indigo-950/40 dark:border-indigo-800 dark:text-indigo-400 font-semibold'
                    : 'bg-white/80 dark:bg-slate-900/50 border-transparent dark:border-slate-800/80 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-500 dark:text-slate-400'
                }`}
              >
                <span className="flex items-center gap-1.5 text-[11px] font-medium truncate min-w-0">
                  <span>{geomEmoji(node, g)}</span>
                  <span
                    className={`truncate ${g.csg === 'difference' && !hw ? 'line-through decoration-rose-400/70' : ''} ${g.internal ? 'italic' : ''}`}
                    title={hw ? 'G moves it, S steps its size; or use its row in the Cut panel' : undefined}
                  >
                    {hw ? `${HARDWARE_KINDS[hw.kind].label} ${hw.size}` : (g.name || `Geom ${idx + 1}`)}
                  </span>
                </span>
                {/* Listed only because generated parts are shown: this lists it always. */}
                {g.internal && (
                  <button
                    onClick={(e) => { e.stopPropagation(); updateNodeGeom(node.id, { internal: undefined }, idx); }}
                    className="ml-auto pl-1 p-0.5 rounded cursor-pointer shrink-0 text-slate-400/70 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-700/60"
                    title="Generated part. Click to list it always, not only with Show generated parts"
                  >
                    <ListPlus className="w-3.5 h-3.5" />
                  </button>
                )}
                {canDeleteSubGeom && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteNodeGeom(node.id, idx);
                      setActiveGeomIndex(0, false);
                    }}
                    className={`${g.internal ? '' : 'ml-auto '}pl-1 p-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer shrink-0 transition-opacity ${
                      isGeomSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    title={`Delete shape "${hw ? `${HARDWARE_KINDS[hw.kind].label} ${hw.size}` : (g.name || `Geom ${idx + 1}`)}"`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {hasChildren && !isCollapsed && (
        <div className="pl-3 ml-2.5 border-l border-slate-200 dark:border-slate-800/60 flex flex-col gap-0.5">
          {node.children.map((child) => (
            <HierarchyRow
              key={child.id}
              node={child}
              depth={depth + 1}
              ancestorHidden={dimmed}
              collapsedIds={collapsedIds}
              onToggleCollapsed={onToggleCollapsed}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The left sidebar's tree: Worldbody, then every body in the scene. */
export function HierarchyTree() {
  const nodes = useStore((s) => s.sceneGraph.nodes);
  const worldSelected = useStore((s) => !s.selectedNodeId);
  const select = useSelectRow();
  const internalCount = countInternal(nodes);
  const showInternal = useTreeView((s) => s.showInternalParts);
  const setShowInternal = useTreeView((s) => s.setShowInternalParts);

  // Bodies folded shut in the hierarchy. View state only, so not in the store,
  // and everything starts open.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col gap-1.5 mb-6">
      <div
        className={`px-3 py-1.5 rounded-md border cursor-pointer transition-colors shadow-sm flex items-center gap-1.5 ${
          worldSelected
            ? 'bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-400 font-bold'
            : 'bg-white dark:bg-slate-900 border-transparent dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
        }`}
        onClick={() => select(null)}
      >
        <span>🌍</span> <span className="text-xs font-semibold">Worldbody</span>
      </div>
      <div className="flex flex-col mt-1">
        {nodes.map((node) => (
          <HierarchyRow
            key={node.id}
            node={node}
            depth={0}
            ancestorHidden={false}
            collapsedIds={collapsedIds}
            onToggleCollapsed={toggleCollapsed}
          />
        ))}
        {/* A blank scene said nothing at all about where to start. */}
        {nodes.length === 0 && (
          <p className="px-3 py-2 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
            Nothing here yet. Drag a part in from Components below, open a scene at the top, or ask the Copilot to build one.
          </p>
        )}
        {/* Parts a builder made from a body's own settings (a dress form's
            head, limbs and torso slabs) are listed only on request. */}
        {internalCount > 0 && (
          <button
            onClick={() => setShowInternal(!showInternal)}
            className="mt-1 self-start px-2 py-1 rounded text-[11px] text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 cursor-pointer"
            title="Parts made from a body's settings, such as a dress form's head, limbs and torso. Listed or not, they draw and collide."
          >
            {showInternal ? 'Hide generated parts' : `Show generated parts (${internalCount})`}
          </button>
        )}
      </div>
    </div>
  );
}
