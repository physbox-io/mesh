import { useState, useMemo } from 'react';
import {
    X,
    Wrench,
    Download,
    Plus,
    ExternalLink,
    ShoppingCart,
    Scissors,
    Box,
    Compass,
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
    type TubeCopeSpec,
    computeTubeCopeJoint,
    extractSceneTubeJoints,
    exportTubeCopeSvg,
    buildTubeCopeEtchUrl,
    type WireBendOptions,
    type WireBendJigOptions,
    computeWireBendSchedule,
    extractSceneWireCurves,
    buildWireBendingJigNode
} from '../utils/tubeAndWireExporter';
import { AddSimulationButton } from './MachineJobControls';
import { sceneStockTransform, useAddSimulation } from '../hooks/useAddSimulation';
import { tubeSimulationRequest, type TubeSimulationJob } from '../utils/tubeSimulation';
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

    const [activeTab, setActiveTab] = useState<'pipe' | 'cope' | 'wire'>('pipe');
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

    // --- Tab 2: Tube Coping State ---
    const sceneMembers = useMemo(() => extractSceneTubeJoints(scene), [scene]);
    const sceneJoints: TubeCopeSpec[] = useMemo(() => {
        const list: TubeCopeSpec[] = [];
        for (const m of sceneMembers) {
            if (m.startCope) list.push(m.startCope.spec);
            if (m.endCope) list.push(m.endCope.spec);
            if (!m.startCope && !m.endCope) {
                list.push({
                    id: m.id,
                    name: m.name,
                    cutTubeOdMm: m.odMm,
                    cutTubeWallMm: m.wallMm,
                    targetKind: 'tube',
                    targetTubeOdMm: m.odMm,
                    angleDeg: 90,
                });
            }
        }
        return list;
    }, [sceneMembers]);
    const [selectedJointIndex, setSelectedJointIndex] = useState<number>(-1);
    const [cutTubeOdMm, setCutTubeOdMm] = useState<number>(33.4);
    const [cutTubeWallMm, setCutTubeWallMm] = useState<number>(3.38);
    const [targetKind, setTargetKind] = useState<'tube' | 'plane'>('tube');
    const [targetTubeOdMm, setTargetTubeOdMm] = useState<number>(42.2);
    const [angleDeg, setAngleDeg] = useState<number>(45);
    const [offsetMm, setOffsetMm] = useState<number>(0);
    const [clockAngleDeg, setClockAngleDeg] = useState<number>(0);

    const handleSelectSceneJoint = (idx: number) => {
        setSelectedJointIndex(idx);
        if (idx >= 0 && idx < sceneJoints.length) {
            const j = sceneJoints[idx];
            setCutTubeOdMm(j.cutTubeOdMm);
            setCutTubeWallMm(j.cutTubeWallMm);
            setTargetKind(j.targetKind);
            setTargetTubeOdMm(j.targetTubeOdMm ?? j.cutTubeOdMm);
            setAngleDeg(j.angleDeg);
            setOffsetMm(j.offsetMm ?? 0);
            setClockAngleDeg(j.clockAngleDeg ?? 0);
        }
    };

    const copeSpec: TubeCopeSpec = useMemo(() => ({
        id: selectedJointIndex >= 0 && sceneJoints[selectedJointIndex]?.id ? sceneJoints[selectedJointIndex].id : 'custom_cope',
        name: selectedJointIndex >= 0 && sceneJoints[selectedJointIndex]?.name ? sceneJoints[selectedJointIndex].name : 'Custom Joint',
        cutTubeOdMm,
        cutTubeWallMm,
        targetKind,
        targetTubeOdMm,
        angleDeg,
        offsetMm,
        clockAngleDeg
    }), [selectedJointIndex, sceneJoints, cutTubeOdMm, cutTubeWallMm, targetKind, targetTubeOdMm, angleDeg, offsetMm, clockAngleDeg]);

    const copeResult = useMemo(() => computeTubeCopeJoint(copeSpec), [copeSpec]);
    const copeSvgResult = useMemo(() => exportTubeCopeSvg([copeSpec]), [copeSpec]);

    // --- Tab 3: Wire Bending State ---
    const sceneWires = useMemo(() => extractSceneWireCurves(scene), [scene]);
    const [selectedWireIdx, setSelectedWireIdx] = useState<number>(0);
    const [wireDiameterMm, setWireDiameterMm] = useState<number>(3.0);
    const [bendRadiusMm, setBendRadiusMm] = useState<number>(6.0);
    const [springbackFactor, setSpringbackFactor] = useState<number>(1.03);
    const [jigBaseThicknessMm, setJigBaseThicknessMm] = useState<number>(6.0);
    const [jigPostHeightMm, setJigPostHeightMm] = useState<number>(12.0);
    const [jigAddedMessage, setJigAddedMessage] = useState<string | null>(null);

    const SAMPLE_BRACKET_POINTS: [number, number, number][] = useMemo(() => [
        [0, 0, 0],
        [45, 0, 0],
        [45, 35, 0],
        [45, 35, 25],
        [85, 35, 25]
    ], []);

    const activeWirePoints = useMemo(() => {
        if (selectedWireIdx >= 0 && selectedWireIdx < sceneWires.length) {
            return sceneWires[selectedWireIdx].pointsMm;
        }
        return SAMPLE_BRACKET_POINTS;
    }, [selectedWireIdx, sceneWires, SAMPLE_BRACKET_POINTS]);

    const wireOptions: Partial<WireBendOptions> = useMemo(() => ({
        wireDiameterMm,
        bendRadiusMm,
        springbackFactor
    }), [wireDiameterMm, bendRadiusMm, springbackFactor]);

    const wireSchedule = useMemo(
        () => computeWireBendSchedule(activeWirePoints, wireOptions),
        [activeWirePoints, wireOptions]
    );

    if (!isOpen) return null;

    /** What this tab hands over, made and put in the scene to measure against the model. */
    const handleSimulate = (job: TubeSimulationJob, placement: 'beside' | 'overlay') => {
        void simulation.add({ ...tubeSimulationRequest(job, sceneStockTransform()).request, placement });
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
            setFrameMessage(`Framed ${selectedBody.name}: ${skeleton.members.length} pipes, none over ${Math.round(skeleton.maxSpanMm)} mm between joints`);
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

    const handleDownloadCopeSvg = () => {
        const blob = new Blob([copeSvgResult.svg], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tube-cope-${copeSpec.id}-${Math.round(cutTubeOdMm)}mm-${Math.round(angleDeg)}deg.svg`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleOpenCopeInEtch = async () => {
        const url = await buildTubeCopeEtchUrl(copeSvgResult);
        window.open(url, '_blank', 'noopener,noreferrer');
    };

    const handleAddWireJigToScene = () => {
        const jigOptions: Partial<WireBendJigOptions> = {
            ...wireOptions,
            baseThicknessMm: jigBaseThicknessMm,
            pegHeightMm: jigPostHeightMm
        };
        const { jigNode } = buildWireBendingJigNode(activeWirePoints, jigOptions);
        const state = useStore.getState();
        const filteredNodes = (state.sceneGraph.nodes || []).filter(n => n.id !== jigNode.id);
        const nextScene: SceneGraph = {
            ...state.sceneGraph,
            nodes: [...filteredNodes, jigNode]
        };
        state.updateScene(nextScene);
        void state.recompile(nextScene);
        setJigAddedMessage(`Added printable wire bending jig "${jigNode.name || jigNode.id}" to scene`);
        setTimeout(() => setJigAddedMessage(null), 3500);
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
                                PVC / EMT Pipe Frame, Tube Coping &amp; Wire Bending Studio
                            </h2>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                10ft/3m conduit cut lists, 3D-printable multi-way hubs, 1:1 fish-mouth wrap templates &amp; CNC/3D wire bending jigs
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

                {/* Tabs */}
                <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 px-5 gap-2 pt-2">
                    <button
                        onClick={() => setActiveTab('pipe')}
                        className={`px-4 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors flex items-center gap-2 ${
                            activeTab === 'pipe'
                                ? 'border-cyan-500 dark:border-cyan-400 text-cyan-700 dark:text-cyan-300 bg-white dark:bg-slate-900'
                                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                        }`}
                    >
                        <Box className="w-3.5 h-3.5" />
                        PVC / EMT Pipe Frame
                    </button>
                    <button
                        onClick={() => setActiveTab('cope')}
                        className={`px-4 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors flex items-center gap-2 ${
                            activeTab === 'cope'
                                ? 'border-cyan-500 dark:border-cyan-400 text-cyan-700 dark:text-cyan-300 bg-white dark:bg-slate-900'
                                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                        }`}
                    >
                        <Scissors className="w-3.5 h-3.5" />
                        Tube Coping (Fish-Mouth)
                    </button>
                    <button
                        onClick={() => setActiveTab('wire')}
                        className={`px-4 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors flex items-center gap-2 ${
                            activeTab === 'wire'
                                ? 'border-cyan-500 dark:border-cyan-400 text-cyan-700 dark:text-cyan-300 bg-white dark:bg-slate-900'
                                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                        }`}
                    >
                        <Compass className="w-3.5 h-3.5" />
                        Wire Bending &amp; 3D Jig
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    {activeTab === 'pipe' && (
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
                                            onChange={e => setPipeStandardId(e.target.value as PipeStandardId)}
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
                                        onSimulate={(placement) => handleSimulate({ frame: breakdown }, placement)}
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
                    )}

                    {activeTab === 'cope' && (
                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                            {/* Left Controls */}
                            <div className="lg:col-span-5 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3.5">
                                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                    Tube Miter &amp; Fish-Mouth Joint Parameters
                                </h3>

                                <div>
                                    <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                                        Detected Scene Joint or Custom Spec
                                    </label>
                                    <select
                                        value={selectedJointIndex}
                                        onChange={e => handleSelectSceneJoint(Number(e.target.value))}
                                        className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                                    >
                                        <option value={-1}>Custom Tube Joint Parameters</option>
                                        {sceneJoints.map((j, idx) => (
                                            <option key={j.id ?? idx} value={idx}>
                                                {j.name ?? j.id ?? `Joint #${idx + 1}`} ({j.angleDeg}° • OD {j.cutTubeOdMm}mm → {j.targetTubeOdMm ?? j.cutTubeOdMm}mm)
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Cut Tube OD (mm)</label>
                                        <input
                                            type="number"
                                            step="0.5"
                                            min="6"
                                            value={cutTubeOdMm}
                                            onChange={e => setCutTubeOdMm(Number(e.target.value))}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Wall Thickness (mm)</label>
                                        <input
                                            type="number"
                                            step="0.2"
                                            min="0.5"
                                            value={cutTubeWallMm}
                                            onChange={e => setCutTubeWallMm(Number(e.target.value))}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Target Surface</label>
                                        <select
                                            value={targetKind}
                                            onChange={e => setTargetKind(e.target.value as 'tube' | 'plane')}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                                        >
                                            <option value="tube">Round Collector Tube (Fish-Mouth)</option>
                                            <option value="plane">Flat Plate / Miter Plane</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Target Tube OD (mm)</label>
                                        <input
                                            type="number"
                                            step="0.5"
                                            min="6"
                                            disabled={targetKind === 'plane'}
                                            value={targetTubeOdMm}
                                            onChange={e => setTargetTubeOdMm(Number(e.target.value))}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 disabled:opacity-50 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Joint Angle (°)</label>
                                        <input
                                            type="number"
                                            step="1"
                                            min="10"
                                            max="170"
                                            value={angleDeg}
                                            onChange={e => setAngleDeg(Number(e.target.value))}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Centerline Offset (mm)</label>
                                        <input
                                            type="number"
                                            step="0.5"
                                            value={offsetMm}
                                            onChange={e => setOffsetMm(Number(e.target.value))}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                                        />
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                                        Clocking Rotation Angle ({clockAngleDeg}°)
                                    </label>
                                    <input
                                        type="range"
                                        min="0"
                                        max="360"
                                        value={clockAngleDeg}
                                        onChange={e => setClockAngleDeg(Number(e.target.value))}
                                        className="w-full"
                                    />
                                </div>

                                <div className="pt-2 flex flex-col gap-2">
                                    <button
                                        onClick={handleDownloadCopeSvg}
                                        className="w-full py-2 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-xs font-semibold text-white flex items-center justify-center gap-2 transition-colors"
                                    >
                                        <Download className="w-4 h-4" />
                                        Download 1:1 Wrap-Around Template (.SVG)
                                    </button>
                                    <button
                                        onClick={handleOpenCopeInEtch}
                                        className="w-full py-2 px-3 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center justify-center gap-2 transition-colors"
                                    >
                                        <ExternalLink className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                                        Open in Etch (2D Laser / Print Layout)
                                    </button>
                                    <AddSimulationButton
                                        disabled={false}
                                        onSimulate={(placement) => handleSimulate({ cope: copeResult }, placement)}
                                        progress={simulation.progress}
                                        error={simulation.error}
                                        besideOnly
                                    />
                                </div>
                            </div>

                            {/* Right 1:1 SVG Preview */}
                            <div className="lg:col-span-7 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex flex-col justify-between space-y-3">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                                            1:1 Unrolled Paper Wrap Template Preview
                                        </h3>
                                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                            Circumference: {copeResult.circumferenceMm} mm • Saddle Depth: {copeResult.peakToValleyOuterMm} mm
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-3 text-[11px]">
                                        <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                                            <span className="w-3 h-0.5 bg-red-500 inline-block" /> Inner-Wall Fit Cut
                                        </span>
                                        <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400">
                                            <span className="w-3 h-0.5 bg-blue-500 inline-block" /> Outer-Wall Bevel
                                        </span>
                                    </div>
                                </div>

                                <div className="bg-white rounded-lg p-3 overflow-auto flex items-center justify-center min-h-[260px]">
                                    <div
                                        className="w-full flex justify-center"
                                        dangerouslySetInnerHTML={{ __html: copeSvgResult.svg }}
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'wire' && (
                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                            {/* Left Wire Settings */}
                            <div className="lg:col-span-5 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3.5">
                                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                    Wire &amp; 3D Bending Jig Configuration
                                </h3>

                                <div>
                                    <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Wire Path Source</label>
                                    <select
                                        value={selectedWireIdx}
                                        onChange={e => setSelectedWireIdx(Number(e.target.value))}
                                        className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                                    >
                                        {sceneWires.map((w, idx) => (
                                            <option key={w.id} value={idx}>
                                                Scene Curve: {w.name} ({w.pointsMm.length} vertices)
                                            </option>
                                        ))}
                                        <option value={-1}>Sample 3D Multi-Bend Bracket Wire Path</option>
                                    </select>
                                </div>

                                <div className="grid grid-cols-3 gap-2.5">
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Wire Ø (mm)</label>
                                        <input
                                            type="number"
                                            step="0.5"
                                            min="0.5"
                                            value={wireDiameterMm}
                                            onChange={e => setWireDiameterMm(Number(e.target.value))}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-900 dark:text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Bend R (mm)</label>
                                        <input
                                            type="number"
                                            step="0.5"
                                            min="1"
                                            value={bendRadiusMm}
                                            onChange={e => setBendRadiusMm(Number(e.target.value))}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-900 dark:text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Springback</label>
                                        <input
                                            type="number"
                                            step="0.01"
                                            min="1.0"
                                            max="1.25"
                                            value={springbackFactor}
                                            onChange={e => setSpringbackFactor(Number(e.target.value))}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-900 dark:text-white"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-2.5">
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Jig Base Plate (mm)</label>
                                        <input
                                            type="number"
                                            step="1"
                                            min="3"
                                            value={jigBaseThicknessMm}
                                            onChange={e => setJigBaseThicknessMm(Number(e.target.value))}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-900 dark:text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Fulcrum Pin Height (mm)</label>
                                        <input
                                            type="number"
                                            step="1"
                                            min="5"
                                            value={jigPostHeightMm}
                                            onChange={e => setJigPostHeightMm(Number(e.target.value))}
                                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-900 dark:text-white"
                                        />
                                    </div>
                                </div>

                                <div className="bg-white dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 rounded-lg p-3 flex items-center justify-between">
                                    <span className="text-xs text-slate-500 dark:text-slate-400">Total Wire Cut Length:</span>
                                    <span className="text-sm font-bold text-cyan-700 dark:text-cyan-300">
                                        {wireSchedule.totalCutLengthMm} mm
                                    </span>
                                </div>

                                <button
                                    onClick={handleAddWireJigToScene}
                                    className="w-full py-2.5 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-xs font-semibold text-white flex items-center justify-center gap-2 transition-colors shadow"
                                >
                                    <Plus className="w-4 h-4" />
                                    Add Printable Wire Bending Jig to Scene
                                </button>
                                <AddSimulationButton
                                    disabled={wireSchedule.pointsMm.length < 2}
                                    onSimulate={(placement) => handleSimulate({ wire: wireSchedule }, placement)}
                                    progress={simulation.progress}
                                    error={simulation.error}
                                />
                                {jigAddedMessage && (
                                    <div className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                                        <Check className="w-3.5 h-3.5" />
                                        {jigAddedMessage}
                                    </div>
                                )}
                            </div>

                            {/* Right LRA Table */}
                            <div className="lg:col-span-7 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                                        LRA (Length • Rotate • Angle) Wire Bending Schedule
                                    </h3>
                                    <span className="text-xs text-slate-500 dark:text-slate-400">
                                        Tail Straight Feed: {wireSchedule.finalStraightMm} mm
                                    </span>
                                </div>

                                <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                                    <table className="w-full text-left text-xs">
                                        <thead className="bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                                            <tr>
                                                <th className="py-2 px-3">Step</th>
                                                <th className="py-2 px-3">Straight Feed (mm)</th>
                                                <th className="py-2 px-3">Rotate (°)</th>
                                                <th className="py-2 px-3">Bend (°)</th>
                                                <th className="py-2 px-3">Overbend (°)</th>
                                                <th className="py-2 px-3">Arc (mm)</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70">
                                            {wireSchedule.steps.map(step => (
                                                <tr key={step.stepIndex} className="hover:bg-slate-100 dark:hover:bg-slate-900/50">
                                                    <td className="py-2 px-3 font-semibold text-cyan-700 dark:text-cyan-300">
                                                        #{step.stepIndex}
                                                    </td>
                                                    <td className="py-2 px-3 text-slate-900 dark:text-white font-mono">
                                                        {step.straightFeedMm}
                                                    </td>
                                                    <td className="py-2 px-3 text-slate-600 dark:text-slate-300 font-mono">
                                                        {step.rotateAngleDeg}°
                                                    </td>
                                                    <td className="py-2 px-3 text-slate-600 dark:text-slate-300 font-mono">
                                                        {step.bendAngleDeg}°
                                                    </td>
                                                    <td className="py-2 px-3 text-amber-700 dark:text-amber-300 font-mono">
                                                        {step.overbendAngleDeg}°
                                                    </td>
                                                    <td className="py-2 px-3 text-slate-500 dark:text-slate-400 font-mono">
                                                        {step.arcLengthMm}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
