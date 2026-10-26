import React, { useState, useMemo } from 'react';
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
    Sparkles,
    Check
} from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import { useStore } from '../store/useStore';
import {
    PIPE_STANDARDS,
    DEFAULT_PIPE_FRAME_OPTIONS,
    type PipeStandardId,
    type PipeStructurePresetId,
    type PipeHubFitStyle,
    type PipeFrameOptions,
    breakdownPipeFrame,
    buildAllCustomHubNodes,
    generatePipeStructurePreset,
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

    // --- Tab 1: PVC / EMT Pipe Frame State ---
    const [pipeStandardId, setPipeStandardId] = useState<PipeStandardId>(DEFAULT_PIPE_FRAME_OPTIONS.pipeStandardId);
    const [fitStyle, setFitStyle] = useState<PipeHubFitStyle>(DEFAULT_PIPE_FRAME_OPTIONS.fitStyle);
    const [hubWallMm, setHubWallMm] = useState<number>(DEFAULT_PIPE_FRAME_OPTIONS.hubWallMm);
    const [fitClearanceMm, setFitClearanceMm] = useState<number>(DEFAULT_PIPE_FRAME_OPTIONS.fitClearanceMm);
    const [crossBoltHoleMm, setCrossBoltHoleMm] = useState<number>(DEFAULT_PIPE_FRAME_OPTIONS.crossBoltHoleMm);
    const [stockLengthMm, setStockLengthMm] = useState<number>(DEFAULT_PIPE_FRAME_OPTIONS.stockLengthMm);
    const [hubAddedMessage, setHubAddedMessage] = useState<string | null>(null);

    const pipeOptions: Partial<PipeFrameOptions> = useMemo(() => ({
        pipeStandardId,
        fitStyle,
        hubWallMm,
        fitClearanceMm,
        crossBoltHoleMm,
        stockLengthMm
    }), [pipeStandardId, fitStyle, hubWallMm, fitClearanceMm, crossBoltHoleMm, stockLengthMm]);

    const breakdown = useMemo(() => breakdownPipeFrame(scene, pipeOptions), [scene, pipeOptions]);

    // --- Tab 2: Tube Coping State ---
    const sceneJoints = useMemo(() => extractSceneTubeJoints(scene), [scene]);
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
            setTargetTubeOdMm(j.targetTubeOdMm);
            setAngleDeg(j.angleDeg);
            setOffsetMm(j.offsetMm);
            setClockAngleDeg(j.clockAngleDeg ?? 0);
        }
    };

    const copeSpec: TubeCopeSpec = useMemo(() => ({
        id: selectedJointIndex >= 0 && sceneJoints[selectedJointIndex] ? sceneJoints[selectedJointIndex].id : 'custom_cope',
        label: selectedJointIndex >= 0 && sceneJoints[selectedJointIndex] ? sceneJoints[selectedJointIndex].label : 'Custom Joint',
        cutTubeOdMm,
        cutTubeWallMm,
        targetKind,
        targetTubeOdMm,
        angleDeg,
        offsetMm,
        clockAngleDeg
    }), [selectedJointIndex, sceneJoints, cutTubeOdMm, cutTubeWallMm, targetKind, targetTubeOdMm, angleDeg, offsetMm, clockAngleDeg]);

    const copeResult = useMemo(() => computeTubeCopeJoint(copeSpec), [copeSpec]);

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
            return sceneWires[selectedWireIdx].points;
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

    const handleLoadPreset = (presetId: PipeStructurePresetId) => {
        const nodes = generatePipeStructurePreset(presetId, { pipeStandardId });
        const state = useStore.getState();
        const nextScene: SceneGraph = {
            ...state.sceneGraph,
            nodes
        };
        state.updateScene(nextScene);
        void state.recompile(nextScene);
    };

    const handleAddHubsToScene = () => {
        const hubNodes = buildAllCustomHubNodes(breakdown);
        if (hubNodes.length === 0) return;
        const state = useStore.getState();
        const existingIds = new Set(hubNodes.map(n => n.id));
        const filteredNodes = (state.sceneGraph.nodes || []).filter(n => !existingIds.has(n.id));
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
        const svgContent = exportTubeCopeSvg(copeResult);
        const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tube-cope-${copeSpec.id}-${Math.round(cutTubeOdMm)}mm-${Math.round(angleDeg)}deg.svg`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleOpenCopeInEtch = () => {
        const url = buildTubeCopeEtchUrl(copeResult);
        window.open(url, '_blank', 'noopener,noreferrer');
    };

    const handleAddWireJigToScene = () => {
        const jigOptions: Partial<WireBendJigOptions> = {
            ...wireOptions,
            baseThicknessMm: jigBaseThicknessMm,
            postHeightMm: jigPostHeightMm
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
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden text-zinc-100">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 bg-zinc-950/60">
                    <div className="flex items-center gap-2.5">
                        <Wrench className="w-5 h-5 text-cyan-400" />
                        <div>
                            <h2 className="text-base font-semibold text-white">
                                PVC / EMT Pipe Frame, Tube Coping &amp; Wire Bending Studio
                            </h2>
                            <p className="text-xs text-zinc-400">
                                10ft/3m conduit cut lists, 3D-printable multi-way hubs, 1:1 fish-mouth wrap templates &amp; CNC/3D wire bending jigs
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                        title="Close"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-zinc-800 bg-zinc-950/40 px-5 gap-2 pt-2">
                    <button
                        onClick={() => setActiveTab('pipe')}
                        className={`px-4 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors flex items-center gap-2 ${
                            activeTab === 'pipe'
                                ? 'border-cyan-400 text-cyan-300 bg-zinc-900'
                                : 'border-transparent text-zinc-400 hover:text-zinc-200'
                        }`}
                    >
                        <Box className="w-3.5 h-3.5" />
                        PVC / EMT Pipe Frame
                    </button>
                    <button
                        onClick={() => setActiveTab('cope')}
                        className={`px-4 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors flex items-center gap-2 ${
                            activeTab === 'cope'
                                ? 'border-cyan-400 text-cyan-300 bg-zinc-900'
                                : 'border-transparent text-zinc-400 hover:text-zinc-200'
                        }`}
                    >
                        <Scissors className="w-3.5 h-3.5" />
                        Tube Coping (Fish-Mouth)
                    </button>
                    <button
                        onClick={() => setActiveTab('wire')}
                        className={`px-4 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors flex items-center gap-2 ${
                            activeTab === 'wire'
                                ? 'border-cyan-400 text-cyan-300 bg-zinc-900'
                                : 'border-transparent text-zinc-400 hover:text-zinc-200'
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
                            {/* Quick Starter Presets */}
                            <div className="bg-zinc-950/60 border border-zinc-800 rounded-lg p-3.5">
                                <div className="flex items-center justify-between flex-wrap gap-2">
                                    <div className="flex items-center gap-2">
                                        <Sparkles className="w-4 h-4 text-amber-400" />
                                        <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">
                                            Quick Starter Frame Presets
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {([
                                            { id: 'mini_greenhouse', label: 'Mini Greenhouse' },
                                            { id: 'yard_pub_canopy', label: 'Yard Pub Canopy' },
                                            { id: 'carport_frame', label: 'Carport Frame' },
                                            { id: 'geodesic_dome', label: 'Geodesic Dome' }
                                        ] as { id: PipeStructurePresetId; label: string }[]).map(preset => (
                                            <button
                                                key={preset.id}
                                                onClick={() => handleLoadPreset(preset.id)}
                                                className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-cyan-950/70 border border-zinc-700 hover:border-cyan-500/50 text-xs font-medium text-zinc-200 hover:text-cyan-200 transition-colors"
                                            >
                                                {preset.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* Configuration Grid */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                {/* Pipe Standard & Stock */}
                                <div className="bg-zinc-950/50 border border-zinc-800 rounded-lg p-4 space-y-3">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                                        Hardware Store Pipe Spec
                                    </h3>
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Pipe / Conduit Standard</label>
                                        <select
                                            value={pipeStandardId}
                                            onChange={e => setPipeStandardId(e.target.value as PipeStandardId)}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white"
                                        >
                                            {PIPE_STANDARDS.map(std => (
                                                <option key={std.id} value={std.id}>
                                                    {std.label} (OD {std.odMm}mm / ID {std.idMm}mm)
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Stock Stick Length</label>
                                        <select
                                            value={stockLengthMm}
                                            onChange={e => setStockLengthMm(Number(e.target.value))}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white"
                                        >
                                            <option value={3048}>10 ft US Standard (3048 mm)</option>
                                            <option value={3000}>3.0 m Metric Standard (3000 mm)</option>
                                            <option value={6096}>20 ft Commercial Stick (6096 mm)</option>
                                            <option value={1524}>5 ft Half Stick (1524 mm)</option>
                                        </select>
                                    </div>
                                </div>

                                {/* 3D Printed Hub Fit Settings */}
                                <div className="bg-zinc-950/50 border border-zinc-800 rounded-lg p-4 space-y-3">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                                        3D-Printed Hub Parameters
                                    </h3>
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Hub Fit Style</label>
                                        <select
                                            value={fitStyle}
                                            onChange={e => setFitStyle(e.target.value as PipeHubFitStyle)}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white"
                                        >
                                            <option value="socket">Socket (Slip-Over Outer Sleeve)</option>
                                            <option value="spigot">Spigot (Internal Core Plug)</option>
                                        </select>
                                    </div>
                                    <div className="grid grid-cols-3 gap-2">
                                        <div>
                                            <label className="block text-[11px] text-zinc-400 mb-1">Wall (mm)</label>
                                            <input
                                                type="number"
                                                step="0.5"
                                                min="2"
                                                max="12"
                                                value={hubWallMm}
                                                onChange={e => setHubWallMm(Number(e.target.value))}
                                                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-white"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-[11px] text-zinc-400 mb-1">Clearance</label>
                                            <input
                                                type="number"
                                                step="0.05"
                                                min="0"
                                                max="2"
                                                value={fitClearanceMm}
                                                onChange={e => setFitClearanceMm(Number(e.target.value))}
                                                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-white"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-[11px] text-zinc-400 mb-1">Bolt Ø (mm)</label>
                                            <input
                                                type="number"
                                                step="0.5"
                                                min="0"
                                                max="12"
                                                value={crossBoltHoleMm}
                                                onChange={e => setCrossBoltHoleMm(Number(e.target.value))}
                                                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-white"
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Store Shopping List Card */}
                                <div className="bg-cyan-950/20 border border-cyan-800/50 rounded-lg p-4 flex flex-col justify-between space-y-3">
                                    <div>
                                        <div className="flex items-center gap-2 mb-2">
                                            <ShoppingCart className="w-4 h-4 text-cyan-400" />
                                            <h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-300">
                                                Store Shopping List
                                            </h3>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2 text-xs">
                                            <div className="bg-zinc-900/80 rounded p-2 border border-zinc-800">
                                                <div className="text-zinc-400 text-[11px]">10ft / 3m Sticks</div>
                                                <div className="text-lg font-bold text-white">
                                                    {breakdown.shoppingList.totalSticksToBuy}
                                                </div>
                                            </div>
                                            <div className="bg-zinc-900/80 rounded p-2 border border-zinc-800">
                                                <div className="text-zinc-400 text-[11px]">3D-Print Hubs</div>
                                                <div className="text-lg font-bold text-amber-300">
                                                    {breakdown.shoppingList.custom3dPrintedHubCount}
                                                </div>
                                            </div>
                                            <div className="bg-zinc-900/80 rounded p-2 border border-zinc-800">
                                                <div className="text-zinc-400 text-[11px]">Std 90° Elbows</div>
                                                <div className="text-sm font-semibold text-emerald-300">
                                                    {breakdown.shoppingList.standard90ElbowCount}
                                                </div>
                                            </div>
                                            <div className="bg-zinc-900/80 rounded p-2 border border-zinc-800">
                                                <div className="text-zinc-400 text-[11px]">Std 90° Tees</div>
                                                <div className="text-sm font-semibold text-emerald-300">
                                                    {breakdown.shoppingList.standardTeeCount}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <button
                                        onClick={handleAddHubsToScene}
                                        disabled={breakdown.hubs.length === 0}
                                        className="w-full py-2 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-xs font-semibold text-white flex items-center justify-center gap-2 transition-colors shadow"
                                    >
                                        <Plus className="w-4 h-4" />
                                        Add 3D-Printable Hub Connectors to Scene ({breakdown.hubs.length})
                                    </button>
                                    {hubAddedMessage && (
                                        <div className="text-xs text-emerald-400 flex items-center gap-1.5">
                                            <Check className="w-3.5 h-3.5" />
                                            {hubAddedMessage}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Visual 10-Foot / 3m Stick Cut-List */}
                            <div className="bg-zinc-950/50 border border-zinc-800 rounded-lg p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
                                        <Layers className="w-4 h-4 text-cyan-400" />
                                        10-Foot / 3m Stick Cut-List ({breakdown.stickPlans.length} Sticks, {breakdown.struts.length} Cut Struts)
                                    </h3>
                                    <span className="text-xs text-zinc-400">
                                        Includes socket end-pullback deduction ({breakdown.pipeStandard.socketDepthMm}mm depth)
                                    </span>
                                </div>

                                {breakdown.stickPlans.length === 0 ? (
                                    <div className="text-xs text-zinc-500 py-6 text-center">
                                        No cylindrical struts found in scene. Click one of the Quick Starter Frame Presets above to populate a pipe frame!
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {breakdown.stickPlans.map(stick => (
                                            <div key={stick.stickIndex} className="space-y-1">
                                                <div className="flex items-center justify-between text-xs">
                                                    <span className="font-medium text-zinc-300">
                                                        Stick #{stick.stickIndex} ({stick.stockLengthMm} mm)
                                                    </span>
                                                    <span className="text-zinc-400">
                                                        Used: {Math.round(stick.usedLengthMm)} mm • Waste: {Math.round(stick.wasteLengthMm)} mm ({stick.wastePercent}%)
                                                    </span>
                                                </div>
                                                <div className="w-full h-7 bg-zinc-900 rounded border border-zinc-800 flex overflow-hidden">
                                                    {stick.cuts.map((cut, cIdx) => {
                                                        const widthPct = Math.max(
                                                            2,
                                                            (cut.cutLengthMm / stick.stockLengthMm) * 100
                                                        );
                                                        return (
                                                            <div
                                                                key={`${cut.strutId}_${cIdx}`}
                                                                style={{ width: `${widthPct}%` }}
                                                                className="h-full bg-cyan-600/80 hover:bg-cyan-500/90 border-r border-zinc-950 flex items-center justify-center px-1 text-[10px] font-medium text-white truncate"
                                                                title={`${cut.label}: ${cut.cutLengthMm} mm`}
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
                            <div className="lg:col-span-5 bg-zinc-950/50 border border-zinc-800 rounded-lg p-4 space-y-3.5">
                                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                                    Tube Miter &amp; Fish-Mouth Joint Parameters
                                </h3>

                                <div>
                                    <label className="block text-xs text-zinc-400 mb-1">
                                        Detected Scene Joint or Custom Spec
                                    </label>
                                    <select
                                        value={selectedJointIndex}
                                        onChange={e => handleSelectSceneJoint(Number(e.target.value))}
                                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white"
                                    >
                                        <option value={-1}>Custom Tube Joint Parameters</option>
                                        {sceneJoints.map((j, idx) => (
                                            <option key={j.id} value={idx}>
                                                {j.label} ({j.angleDeg}° • OD {j.cutTubeOdMm}mm → {j.targetTubeOdMm}mm)
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Cut Tube OD (mm)</label>
                                        <input
                                            type="number"
                                            step="0.5"
                                            min="6"
                                            value={cutTubeOdMm}
                                            onChange={e => setCutTubeOdMm(Number(e.target.value))}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Wall Thickness (mm)</label>
                                        <input
                                            type="number"
                                            step="0.2"
                                            min="0.5"
                                            value={cutTubeWallMm}
                                            onChange={e => setCutTubeWallMm(Number(e.target.value))}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Target Surface</label>
                                        <select
                                            value={targetKind}
                                            onChange={e => setTargetKind(e.target.value as 'tube' | 'plane')}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white"
                                        >
                                            <option value="tube">Round Collector Tube (Fish-Mouth)</option>
                                            <option value="plane">Flat Plate / Miter Plane</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Target Tube OD (mm)</label>
                                        <input
                                            type="number"
                                            step="0.5"
                                            min="6"
                                            disabled={targetKind === 'plane'}
                                            value={targetTubeOdMm}
                                            onChange={e => setTargetTubeOdMm(Number(e.target.value))}
                                            className="w-full bg-zinc-900 border border-zinc-700 disabled:opacity-50 rounded px-2.5 py-1.5 text-xs text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Joint Angle (°)</label>
                                        <input
                                            type="number"
                                            step="1"
                                            min="10"
                                            max="170"
                                            value={angleDeg}
                                            onChange={e => setAngleDeg(Number(e.target.value))}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Centerline Offset (mm)</label>
                                        <input
                                            type="number"
                                            step="0.5"
                                            value={offsetMm}
                                            onChange={e => setOffsetMm(Number(e.target.value))}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white"
                                        />
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-xs text-zinc-400 mb-1">
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
                                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-semibold text-zinc-200 flex items-center justify-center gap-2 transition-colors"
                                    >
                                        <ExternalLink className="w-4 h-4 text-cyan-400" />
                                        Open in Etch (2D Laser / Print Layout)
                                    </button>
                                </div>
                            </div>

                            {/* Right 1:1 SVG Preview */}
                            <div className="lg:col-span-7 bg-zinc-950/50 border border-zinc-800 rounded-lg p-4 flex flex-col justify-between space-y-3">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                                            1:1 Unrolled Paper Wrap Template Preview
                                        </h3>
                                        <p className="text-[11px] text-zinc-400">
                                            Circumference: {copeResult.circumferenceMm} mm • Saddle Depth: {copeResult.saddleDepthMm} mm
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-3 text-[11px]">
                                        <span className="flex items-center gap-1 text-red-400">
                                            <span className="w-3 h-0.5 bg-red-500 inline-block" /> Inner-Wall Fit Cut
                                        </span>
                                        <span className="flex items-center gap-1 text-blue-400">
                                            <span className="w-3 h-0.5 bg-blue-500 inline-block" /> Outer-Wall Bevel
                                        </span>
                                    </div>
                                </div>

                                <div className="bg-white rounded-lg p-3 overflow-auto flex items-center justify-center min-h-[260px]">
                                    <div
                                        className="w-full flex justify-center"
                                        dangerouslySetInnerHTML={{ __html: copeResult.svgString }}
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'wire' && (
                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                            {/* Left Wire Settings */}
                            <div className="lg:col-span-5 bg-zinc-950/50 border border-zinc-800 rounded-lg p-4 space-y-3.5">
                                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                                    Wire &amp; 3D Bending Jig Configuration
                                </h3>

                                <div>
                                    <label className="block text-xs text-zinc-400 mb-1">Wire Path Source</label>
                                    <select
                                        value={selectedWireIdx}
                                        onChange={e => setSelectedWireIdx(Number(e.target.value))}
                                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white"
                                    >
                                        {sceneWires.map((w, idx) => (
                                            <option key={w.id} value={idx}>
                                                Scene Curve: {w.label} ({w.points.length} vertices)
                                            </option>
                                        ))}
                                        <option value={-1}>Sample 3D Multi-Bend Bracket Wire Path</option>
                                    </select>
                                </div>

                                <div className="grid grid-cols-3 gap-2.5">
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Wire Ø (mm)</label>
                                        <input
                                            type="number"
                                            step="0.5"
                                            min="0.5"
                                            value={wireDiameterMm}
                                            onChange={e => setWireDiameterMm(Number(e.target.value))}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Bend R (mm)</label>
                                        <input
                                            type="number"
                                            step="0.5"
                                            min="1"
                                            value={bendRadiusMm}
                                            onChange={e => setBendRadiusMm(Number(e.target.value))}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Springback</label>
                                        <input
                                            type="number"
                                            step="0.01"
                                            min="1.0"
                                            max="1.25"
                                            value={springbackFactor}
                                            onChange={e => setSpringbackFactor(Number(e.target.value))}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-2.5">
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Jig Base Plate (mm)</label>
                                        <input
                                            type="number"
                                            step="1"
                                            min="3"
                                            value={jigBaseThicknessMm}
                                            onChange={e => setJigBaseThicknessMm(Number(e.target.value))}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-zinc-400 mb-1">Fulcrum Pin Height (mm)</label>
                                        <input
                                            type="number"
                                            step="1"
                                            min="5"
                                            value={jigPostHeightMm}
                                            onChange={e => setJigPostHeightMm(Number(e.target.value))}
                                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white"
                                        />
                                    </div>
                                </div>

                                <div className="bg-zinc-900/90 border border-zinc-800 rounded-lg p-3 flex items-center justify-between">
                                    <span className="text-xs text-zinc-400">Total Wire Cut Length:</span>
                                    <span className="text-sm font-bold text-cyan-300">
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
                                {jigAddedMessage && (
                                    <div className="text-xs text-emerald-400 flex items-center gap-1.5">
                                        <Check className="w-3.5 h-3.5" />
                                        {jigAddedMessage}
                                    </div>
                                )}
                            </div>

                            {/* Right LRA Table */}
                            <div className="lg:col-span-7 bg-zinc-950/50 border border-zinc-800 rounded-lg p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                                        LRA (Length • Rotate • Angle) Wire Bending Schedule
                                    </h3>
                                    <span className="text-xs text-zinc-400">
                                        Tail Straight Feed: {wireSchedule.finalStraightFeedMm} mm
                                    </span>
                                </div>

                                <div className="overflow-x-auto border border-zinc-800 rounded-lg">
                                    <table className="w-full text-left text-xs">
                                        <thead className="bg-zinc-900 text-zinc-400 border-b border-zinc-800">
                                            <tr>
                                                <th className="py-2 px-3">Step</th>
                                                <th className="py-2 px-3">Straight Feed (mm)</th>
                                                <th className="py-2 px-3">Rotate (°)</th>
                                                <th className="py-2 px-3">Bend (°)</th>
                                                <th className="py-2 px-3">Overbend (°)</th>
                                                <th className="py-2 px-3">Arc (mm)</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-zinc-800/70">
                                            {wireSchedule.steps.map(step => (
                                                <tr key={step.stepIndex} className="hover:bg-zinc-900/50">
                                                    <td className="py-2 px-3 font-semibold text-cyan-300">
                                                        #{step.stepIndex}
                                                    </td>
                                                    <td className="py-2 px-3 text-white font-mono">
                                                        {step.straightFeedMm}
                                                    </td>
                                                    <td className="py-2 px-3 text-zinc-300 font-mono">
                                                        {step.rotateDeg}°
                                                    </td>
                                                    <td className="py-2 px-3 text-zinc-300 font-mono">
                                                        {step.bendAngleDeg}°
                                                    </td>
                                                    <td className="py-2 px-3 text-amber-300 font-mono">
                                                        {step.springbackCompensatedAngleDeg}°
                                                    </td>
                                                    <td className="py-2 px-3 text-zinc-400 font-mono">
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
