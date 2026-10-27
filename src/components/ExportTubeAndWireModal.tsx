import { useState, useMemo } from 'react';
import {
    X,
    Wrench,
    Plus,
    ShoppingCart,
    Box,
    Layers,
    Check
} from 'lucide-react';
import type { SceneGraph, SceneNode } from '../types/scene';
import { useStore } from '../store/useStore';
import {
    PIPE_STANDARDS,
    DEFAULT_PIPE_FRAME_OPTIONS,
    type PipeStandardId,
    type PipeHubFitStyle,
    type PipeFrameOptions,
    breakdownPipeFrame,
    buildAllCustomHubNodes,
    withoutHubsAt,
} from '../utils/tubeAndWireExporter';
import { AddSimulationButton } from './MachineJobControls';
import { sceneStockTransform, useAddSimulation } from '../hooks/useAddSimulation';
import { pipeFrameSimulationRequest } from '../utils/tubeSimulation';
import { defaultMaxSpanMm, frameBodyInScene, type FramePlacement } from '../utils/pipeSkeleton';

function findBody(nodes: SceneNode[], id: string | null): SceneNode | null {
    if (!id) return null;
    for (const n of nodes) {
        if (n.id === id) return n;
        const hit = findBody(n.children || [], id);
        if (hit) return hit;
    }
    return null;
}

export function ExportTubeAndWireModal({
    isOpen,
    onClose,
    scene: propScene
}: {
    isOpen: boolean;
    onClose: () => void;
    scene?: SceneGraph;
}) {
    const storeScene = useStore(s => s.sceneGraph);
    const scene = propScene || storeScene;

    const simulation = useAddSimulation();

    // --- Tab 1: PVC / EMT Pipe Frame State ---
    const [pipeStandardId, setPipeStandardId] = useState<PipeStandardId>(DEFAULT_PIPE_FRAME_OPTIONS.pipeStandardId);
    const [fitStyle, setFitStyle] = useState<PipeHubFitStyle>(DEFAULT_PIPE_FRAME_OPTIONS.hubFitStyle);
    const [hubWallMm, setHubWallMm] = useState<number>(DEFAULT_PIPE_FRAME_OPTIONS.hubWallMm);
    const [fitClearanceMm, setFitClearanceMm] = useState<number>(DEFAULT_PIPE_FRAME_OPTIONS.fitClearanceMm);
    const [crossBoltHoleMm, setCrossBoltHoleMm] = useState<number>(DEFAULT_PIPE_FRAME_OPTIONS.crossBoltHoleMm);
    const [stockLengthMm, setStockLengthMm] = useState<number>(DEFAULT_PIPE_FRAME_OPTIONS.stockLengthMm ?? 3048);
    const [hubAddedMessage, setHubAddedMessage] = useState<string | null>(null);

    const pipeOptions: Partial<PipeFrameOptions> = useMemo(() => ({
        pipeStandardId,
        hubFitStyle: fitStyle,
        hubWallMm,
        fitClearanceMm,
        crossBoltHoleMm,
        stockLengthMm
    }), [pipeStandardId, fitStyle, hubWallMm, fitClearanceMm, crossBoltHoleMm, stockLengthMm]);

    const breakdown = useMemo(() => breakdownPipeFrame(scene, pipeOptions), [scene, pipeOptions]);

    // --- Frame a shape: a lattice sketch or any solid, made into a supported frame ---
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const selectedBody = findBody(scene.nodes, selectedNodeId);
    const pipeDefaultSpanMm = defaultMaxSpanMm(PIPE_STANDARDS[pipeStandardId]);
    const [frameSpanMm, setFrameSpanMm] = useState<number | null>(null);
    const [frameDiagonals, setFrameDiagonals] = useState(false);
    const [framePosts, setFramePosts] = useState(true);
    const [framePlacement, setFramePlacement] = useState<FramePlacement>('replace');
    const [frameMessage, setFrameMessage] = useState<string | null>(null);

    if (!isOpen) return null;

    /** The frame made from its cut list, every tube seated hub to hub. */
    const handleSimulate = (placement: 'beside' | 'overlay') => {
        void simulation.add({ ...pipeFrameSimulationRequest(breakdown, sceneStockTransform()).request, placement });
    };

    /** A pipe, and the length it is sold in. */
    const choosePipe = (id: PipeStandardId) => {
        setPipeStandardId(id);
        setStockLengthMm(PIPE_STANDARDS[id].stockLengthMm);
    };

    const handleFrameShape = () => {
        if (!selectedBody) return;
        const state = useStore.getState();
        try {
            const { nodes, skeleton } = frameBodyInScene(state.sceneGraph, selectedBody.id, {
                maxSpanMm: frameSpanMm ?? pipeDefaultSpanMm,
                diagonals: frameDiagonals,
                posts: framePosts,
                placement: framePlacement,
                pipeStandardId,
            });
            state.prepareForDiscreteChange();
            const nextScene: SceneGraph = { ...state.sceneGraph, nodes };
            state.updateScene(nextScene);
            void state.recompile(nextScene);
            // Too small for the pipe chosen: framed in tube that suits it, and the cut list follows.
            if (skeleton.resizedFrom) choosePipe(skeleton.pipeStandardId);
            setFrameMessage(
                `Framed ${selectedBody.name}: ${skeleton.members.length} pipes, none over ${Math.round(skeleton.maxSpanMm)} mm between joints` +
                (skeleton.resizedFrom
                    ? `. In ${PIPE_STANDARDS[skeleton.pipeStandardId].label}: ${PIPE_STANDARDS[skeleton.resizedFrom].label} is too big for it.`
                    : '')
            );
        } catch (e) {
            setFrameMessage((e as Error).message);
        }
        setTimeout(() => setFrameMessage(null), 5000);
    };

    const handleAddHubsToScene = () => {
        const hubNodes = buildAllCustomHubNodes(breakdown);
        if (hubNodes.length === 0) return;
        const state = useStore.getState();
        const filteredNodes = withoutHubsAt(state.sceneGraph.nodes || [], hubNodes);
        const nextScene: SceneGraph = {
            ...state.sceneGraph,
            nodes: [...filteredNodes, ...hubNodes]
        };
        state.updateScene(nextScene);
        void state.recompile(nextScene);
        setHubAddedMessage(`Added ${hubNodes.length} 3D-printable hub connector(s) to scene`);
        setTimeout(() => setHubAddedMessage(null), 3500);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden text-slate-800 dark:text-slate-100">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
                    <div className="flex items-center gap-2.5">
                        <Wrench className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
                        <div>
                            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                                Pipe Frame
                            </h2>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                Frame a shape in PVC, EMT or aluminium tube: the stick cut list and the 3D-printable hubs
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        title="Close"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                        <div className="space-y-5">
                            {/* Frame a shape */}
                            <div className="bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
                                <div className="flex items-center justify-between flex-wrap gap-2">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                        Frame a Shape
                                    </h3>
                                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                                        {selectedBody
                                            ? <>Selected: <span className="font-semibold text-slate-700 dark:text-slate-200">{selectedBody.name}</span>{selectedBody.latticeCage ? ' (sketch)' : ''}</>
                                            : 'Select a lattice sketch or any solid'}
                                    </span>
                                </div>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                    Lines drawn in a lattice become pipes; a solid is framed on its surface. Rails, posts and base rails are added so no pipe runs further than the span between joints that hold it.
                                </p>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
                                    <label className="space-y-1 block">
                                        <span className="text-[11px] text-slate-500 dark:text-slate-400" title="How far this pipe may run between joints: where it sags L/140 full of water, as PVC makers' support tables">Max span (mm)</span>
                                        <input
                                            type="number"
                                            min={200}
                                            step={50}
                                            value={frameSpanMm ?? pipeDefaultSpanMm}
                                            onChange={e => setFrameSpanMm(Number(e.target.value) > 0 ? Number(e.target.value) : null)}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs text-slate-900 dark:text-white"
                                        />
                                    </label>
                                    <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                                        <input type="checkbox" checked={framePosts} onChange={e => setFramePosts(e.target.checked)} />
                                        Posts to the floor
                                    </label>
                                    <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                                        <input type="checkbox" checked={frameDiagonals} onChange={e => setFrameDiagonals(e.target.checked)} />
                                        Diagonal bracing
                                    </label>
                                    <select
                                        value={framePlacement}
                                        onChange={e => setFramePlacement(e.target.value as FramePlacement)}
                                        className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs text-slate-900 dark:text-white"
                                    >
                                        <option value="replace">Replace the shape</option>
                                        <option value="beside">Beside the shape</option>
                                    </select>
                                </div>
                                <button
                                    onClick={handleFrameShape}
                                    disabled={!selectedBody}
                                    className="w-full py-2 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 dark:disabled:text-slate-500 text-xs font-semibold text-white flex items-center justify-center gap-2 transition-colors"
                                >
                                    <Box className="w-4 h-4" />
                                    Build Pipe Frame
                                </button>
                                {frameMessage && (
                                    <div className="text-xs text-emerald-600 dark:text-emerald-400">{frameMessage}</div>
                                )}
                            </div>

                            {/* Configuration Grid */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                {/* Pipe Standard & Stock */}
                                <div className="bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                        Hardware Store Pipe Spec
                                    </h3>
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Pipe / Conduit Standard</label>
                                        <select
                                            value={pipeStandardId}
                                            onChange={e => choosePipe(e.target.value as PipeStandardId)}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                                        >
                                            {Object.values(PIPE_STANDARDS).map(std => (
                                                <option key={std.id} value={std.id}>
                                                    {std.label} (OD {std.odMm}mm / ID {std.idMm}mm)
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Stock Stick Length</label>
                                        <select
                                            value={stockLengthMm}
                                            onChange={e => setStockLengthMm(Number(e.target.value))}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                                        >
                                            <option value={3048}>10 ft US Standard (3048 mm)</option>
                                            <option value={3000}>3.0 m Metric Standard (3000 mm)</option>
                                            <option value={6096}>20 ft Commercial Stick (6096 mm)</option>
                                            <option value={1524}>5 ft Half Stick (1524 mm)</option>
                                            <option value={1000}>1 m Length (1000 mm)</option>
                                        </select>
                                    </div>
                                </div>

                                {/* 3D Printed Hub Fit Settings */}
                                <div className="bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                        3D-Printed Hub Parameters
                                    </h3>
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Hub Fit Style</label>
                                        <select
                                            value={fitStyle}
                                            onChange={e => setFitStyle(e.target.value as PipeHubFitStyle)}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                                        >
                                            <option value="socket">Socket (Slip-Over Outer Sleeve)</option>
                                            <option value="spigot">Spigot (Internal Core Plug)</option>
                                        </select>
                                    </div>
                                    <div className="grid grid-cols-3 gap-2">
                                        <div>
                                            <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Wall (mm)</label>
                                            <input
                                                type="number"
                                                step="0.5"
                                                min="2"
                                                max="12"
                                                value={hubWallMm}
                                                onChange={e => setHubWallMm(Number(e.target.value))}
                                                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs text-slate-900 dark:text-white"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Clearance</label>
                                            <input
                                                type="number"
                                                step="0.05"
                                                min="0"
                                                max="2"
                                                value={fitClearanceMm}
                                                onChange={e => setFitClearanceMm(Number(e.target.value))}
                                                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs text-slate-900 dark:text-white"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Bolt Ø (mm)</label>
                                            <input
                                                type="number"
                                                step="0.5"
                                                min="0"
                                                max="12"
                                                value={crossBoltHoleMm}
                                                onChange={e => setCrossBoltHoleMm(Number(e.target.value))}
                                                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs text-slate-900 dark:text-white"
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Store Shopping List Card */}
                                <div className="bg-cyan-50 dark:bg-cyan-950/20 border border-cyan-200 dark:border-cyan-800/50 rounded-lg p-4 flex flex-col justify-between space-y-3">
                                    <div>
                                        <div className="flex items-center gap-2 mb-2">
                                            <ShoppingCart className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                                            <h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">
                                                Store Shopping List
                                            </h3>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2 text-xs">
                                            <div className="bg-white dark:bg-slate-900/80 rounded p-2 border border-slate-200 dark:border-slate-800">
                                                <div className="text-slate-500 dark:text-slate-400 text-[11px]">10ft / 3m Sticks</div>
                                                <div className="text-lg font-bold text-slate-900 dark:text-white">
                                                    {breakdown.shoppingList.sticksToBuy}
                                                </div>
                                            </div>
                                            <div className="bg-white dark:bg-slate-900/80 rounded p-2 border border-slate-200 dark:border-slate-800">
                                                <div className="text-slate-500 dark:text-slate-400 text-[11px]">3D-Print Hubs</div>
                                                <div className="text-lg font-bold text-amber-700 dark:text-amber-300">
                                                    {breakdown.shoppingList.customPrintedHubs}
                                                </div>
                                            </div>
                                            <div className="bg-white dark:bg-slate-900/80 rounded p-2 border border-slate-200 dark:border-slate-800">
                                                <div className="text-slate-500 dark:text-slate-400 text-[11px]">Std 90° Elbows</div>
                                                <div className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                                                    {breakdown.shoppingList.standardElbows90}
                                                </div>
                                            </div>
                                            <div className="bg-white dark:bg-slate-900/80 rounded p-2 border border-slate-200 dark:border-slate-800">
                                                <div className="text-slate-500 dark:text-slate-400 text-[11px]">Std 90° Tees</div>
                                                <div className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                                                    {breakdown.shoppingList.standardTees90}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <button
                                        onClick={handleAddHubsToScene}
                                        disabled={breakdown.hubs.length === 0}
                                        className="w-full py-2 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 dark:disabled:text-slate-500 text-xs font-semibold text-white flex items-center justify-center gap-2 transition-colors shadow"
                                    >
                                        <Plus className="w-4 h-4" />
                                        Add 3D-Printable Hub Connectors to Scene ({breakdown.hubs.length})
                                    </button>
                                    <AddSimulationButton
                                        disabled={breakdown.struts.length === 0}
                                        disabledReason="No pipes in the scene yet: build a frame above, or open a pipe frame from Examples."
                                        onSimulate={handleSimulate}
                                        progress={simulation.progress}
                                        error={simulation.error}
                                    />
                                    {hubAddedMessage && (
                                        <div className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                                            <Check className="w-3.5 h-3.5" />
                                            {hubAddedMessage}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Visual 10-Foot / 3m Stick Cut-List */}
                            <div className="bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300 flex items-center gap-2">
                                        <Layers className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                                        10-Foot / 3m Stick Cut-List ({breakdown.sticks.length} Sticks, {breakdown.struts.length} Cut Struts)
                                    </h3>
                                    <span className="text-xs text-slate-500 dark:text-slate-400">
                                        Includes socket end-pullback deduction ({breakdown.pipeSpec.socketDepthMm}mm depth)
                                    </span>
                                </div>

                                {breakdown.sticks.length === 0 ? (
                                    <div className="text-xs text-slate-400 dark:text-slate-500 py-6 text-center">
                                        No struts in the scene. Lay cylinders end to end, one per length of pipe, or open a pipe frame from Examples &gt; Make it.
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {breakdown.sticks.map(stick => (
                                            <div key={stick.stickIndex} className="space-y-1">
                                                <div className="flex items-center justify-between text-xs">
                                                    <span className="font-medium text-slate-600 dark:text-slate-300">
                                                        Stick #{stick.stickIndex} ({stick.stockLengthMm} mm)
                                                    </span>
                                                    <span className="text-slate-500 dark:text-slate-400">
                                                        Used: {Math.round(stick.usedMm)} mm • Waste: {Math.round(stick.wasteMm)} mm ({Math.round(100 - stick.utilizationPct)}%)
                                                    </span>
                                                </div>
                                                <div className="w-full h-7 bg-white dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-800 flex overflow-hidden">
                                                    {stick.cuts.map((cut, cIdx) => {
                                                        const widthPct = Math.max(
                                                            2,
                                                            (cut.cutLengthMm / stick.stockLengthMm) * 100
                                                        );
                                                        return (
                                                            <div
                                                                key={`${cut.strutId}_${cIdx}`}
                                                                style={{ width: `${widthPct}%` }}
                                                                className="h-full bg-cyan-600/80 hover:bg-cyan-500/90 border-r border-white dark:border-slate-950 flex items-center justify-center px-1 text-[10px] font-medium text-white truncate"
                                                                title={`${cut.name}: ${cut.cutLengthMm} mm`}
                                                            >
                                                                {cut.cutLengthMm}mm
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                </div>
            </div>
        </div>
    );
}
