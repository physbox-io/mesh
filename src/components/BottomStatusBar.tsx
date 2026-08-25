import React, { useEffect, useState } from 'react';
import { Cpu, Layers2, Pause, Play, Square, Wrench } from 'lucide-react';
import { useStore } from '../store/useStore';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { MATERIALS, type MaterialId } from '../utils/feedsAndSpeeds';
import { formatDuration } from '../utils/timeEstimate';
import type { SceneGraph } from '../types/scene';

/**
 * Counts geoms and vertices for the scene readout.
 *
 * Walks the same way the compiler does — a node with an explicit `geoms` array
 * contributes one per entry, and a node without one still contributes itself —
 * so the number here matches what actually reaches MuJoCo rather than counting
 * tree nodes.
 */
/** Only the fields the count actually reads; a scene geom carries many more. */
interface CountableGeom {
  type?: string;
  vertices?: number[];
  renderVertices?: number[];
}

interface CountableNode {
  geoms?: CountableGeom[];
  meshVertices?: number[];
  children?: CountableNode[];
}

function sceneMetrics(scene: SceneGraph | undefined): { geoms: number; vertices: number } {
  let geoms = 0;
  let vertices = 0;

  const countGeomVerts = (g: CountableGeom | undefined) => {
    if (!g) return;
    if (Array.isArray(g.vertices) && g.vertices.length > 0) {
      vertices += Math.floor(g.vertices.length / 3);
    } else if (Array.isArray(g.renderVertices) && g.renderVertices.length > 0) {
      vertices += Math.floor(g.renderVertices.length / 3);
    } else if (g.type === 'box' || g.type === 'cube' || g.type === 'plane') {
      vertices += 24;
    } else if (g.type === 'capsule') {
      vertices += 48;
    } else if (g.type === 'cylinder') {
      vertices += 64;
    } else if (g.type === 'sphere' || g.type === 'ellipsoid') {
      vertices += 128;
    } else {
      vertices += 24;
    }
  };

  const walk = (nodes: CountableNode[]) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (Array.isArray(n.geoms) && n.geoms.length > 0) {
        geoms += n.geoms.length;
        n.geoms.forEach(countGeomVerts);
      } else {
        geoms += 1;
        if (Array.isArray(n.meshVertices) && n.meshVertices.length > 0) {
          vertices += Math.floor(n.meshVertices.length / 3);
        } else {
          vertices += 24;
        }
      }
      if (n.children) walk(n.children);
    }
  };

  walk((scene?.nodes ?? []) as CountableNode[]);
  return { geoms, vertices };
}

/**
 * The status bar along the bottom of the app.
 *
 * Two jobs. It reports the scene, and it holds the two settings that describe
 * the workshop rather than any one export — what the job is cut on, and what
 * it is cut out of. Those were previously chosen inside each export modal,
 * which meant answering them once per operation and being able to answer them
 * inconsistently between operations.
 *
 * The running-job controls are out here on purpose. A cutter does not stop
 * because you closed a dialog, so the stop button must be reachable with every
 * modal shut.
 */
export const BottomStatusBar: React.FC<{ onOpenMachineConfig: () => void }> = ({
  onOpenMachineConfig,
}) => {
  const sceneGraph = useStore((s) => s.sceneGraph);
  const isPlaying = useStore((s) => s.isPlaying);
  const machineTarget = useStore((s) => s.machineTarget);
  const setMachineTarget = useStore((s) => s.setMachineTarget);
  const material = useStore((s) => s.material);
  const setMaterial = useStore((s) => s.setMaterial);

  // Seeded from the manager rather than a literal, so a bar that mounts after a
  // connection shows the real state instead of a disconnected one.
  const [machineState, setMachineState] = useState<MachineState>(webSerialManager.getState());
  useEffect(() => webSerialManager.addListener(setMachineState), []);

  const { geoms, vertices } = sceneMetrics(sceneGraph);
  const running = machineState.status === 'RUNNING' || machineState.status.startsWith('PAUSED');
  const paused = machineState.status.startsWith('PAUSED');
  const parked = machineState.status === 'PAUSED_PARKED';

  const selectClass =
    'bg-transparent text-slate-800 dark:text-slate-200 font-semibold rounded px-1 py-0.5 outline-none cursor-pointer border-none';

  return (
    /*
      Below `lg` the bar wraps rather than squeezing. The material and the
      machine are what the feeds are derived from and a running job's stop
      button is a safety control, so none of it is dropped on a narrow screen.
    */
    <footer className="h-8 shrink-0 w-full bg-white dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800/80 px-4 flex items-center justify-between z-20 text-[11px] text-slate-500 dark:text-slate-400 font-mono select-none transition-colors max-lg:h-auto max-lg:flex-wrap max-lg:justify-start max-lg:px-2 max-lg:py-1 max-lg:gap-x-3 max-lg:gap-y-1">
      {/* Scene metrics */}
      <div className="flex items-center gap-3 max-lg:shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-700 dark:text-slate-300">
            Components: {sceneGraph?.nodes?.length || 0}
          </span>
          <span>·</span>
          <span>Geoms: {geoms}</span>
          <span>·</span>
          <span>Vertices: {vertices.toLocaleString()}</span>
        </div>
      </div>

      {/* What it is cut on, and what out of */}
      <div className="flex items-center gap-2 max-lg:shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <Cpu className="w-3.5 h-3.5 text-amber-500" />
          <select
            value={machineTarget}
            onChange={(e) => setMachineTarget(e.target.value === 'laser' ? 'laser' : 'cnc')}
            title="What this scene is cut on. A laser has no Z depth; a router does."
            className={selectClass}
          >
            <option value="cnc">CNC Router</option>
            <option value="laser">Laser</option>
          </select>

          <div className="w-px h-3 bg-slate-200 dark:bg-slate-800 mx-0.5" />

          <Layers2 className="w-3.5 h-3.5 text-emerald-500" />
          <select
            value={material}
            onChange={(e) => setMaterial(e.target.value as MaterialId)}
            title="What the stock is. Feeds, speeds and spindle RPM are derived from it."
            className={selectClass}
          >
            {MATERIALS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Machine and simulation status */}
      <div className="flex items-center gap-3 max-lg:shrink-0">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              machineState.connected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400 dark:bg-slate-600'
            }`}
          />
          <span>Machine:</span>
          <span
            className={
              machineState.connected
                ? 'text-emerald-600 dark:text-emerald-400 font-bold'
                : 'text-slate-400'
            }
          >
            {machineState.status}
          </span>
          {/* Next to the status it acts on. A disconnected machine is the
              moment someone wants this button, and it is no use sitting over
              in the material group. */}
          <button
            onClick={onOpenMachineConfig}
            className="p-1 rounded text-amber-600 dark:text-amber-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            title="Connect the machine, home it, and set the work origin"
          >
            <Wrench className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* A running job stays visible and stoppable with every panel closed. */}
        {running && (
          <div className="flex items-center gap-2">
            <div className="w-px h-3 bg-slate-200 dark:bg-slate-800" />
            <span className="text-slate-700 dark:text-slate-200">
              {parked ? 'Parked' : paused ? 'Paused' : 'Cutting'}
            </span>
            {/* Time, not lines. See `elapsedSeconds` in webSerialManager for why
                the line count cannot answer "how much longer". The line count
                is still shown, labelled as what it is — lines sent, which is
                what to quote when something has gone wrong and you need to know
                where in the file it is. */}
            <span className="tabular-nums text-slate-700 dark:text-slate-200">
              {formatDuration(machineState.elapsedSeconds)}
              {machineState.estimatedSeconds !== null && (
                <>
                  {' / '}
                  {formatDuration(machineState.estimatedSeconds)}
                  <span className="text-slate-400">
                    {' '}
                    ({formatDuration(Math.max(0, machineState.estimatedSeconds - machineState.elapsedSeconds))} left)
                  </span>
                </>
              )}
            </span>
            <div
              className="w-20 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden"
              title={
                machineState.estimatedSeconds !== null
                  ? 'Elapsed against the estimated run time'
                  : 'Lines sent to the controller — the job did not quote a run time'
              }
            >
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{
                  width: `${
                    machineState.estimatedSeconds
                      ? Math.min(100, (machineState.elapsedSeconds / machineState.estimatedSeconds) * 100)
                      : machineState.progressPercent
                  }%`,
                }}
              />
            </div>
            <span className="text-slate-400">
              line {machineState.currentLine}/{machineState.totalLines} sent
            </span>
            {/* Why it stopped, next to the button that restarts it — a tool
                change is an instruction, and it is no use only in a panel the
                operator has closed. */}
            {machineState.pauseMessage && (
              <span className="text-amber-600 dark:text-amber-400 truncate max-w-[22rem]">
                {machineState.pauseMessage}
              </span>
            )}
            <button
              onClick={() => (paused ? webSerialManager.resumeJob() : webSerialManager.pauseJob())}
              title={paused ? 'Resume the job' : 'Pause the job'}
              className="p-0.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white cursor-pointer"
            >
              {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => webSerialManager.cancelJob()}
              title="Stop the job"
              className="p-0.5 text-red-500 hover:text-red-600 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
          <span className="text-slate-700 dark:text-slate-300 font-semibold">
            {isPlaying ? 'Simulation Running' : 'Simulation Paused'}
          </span>
        </div>
      </div>
    </footer>
  );
};
