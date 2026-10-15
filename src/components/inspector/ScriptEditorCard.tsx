import { useCallback, useState } from 'react';
import { Code, Info, Zap } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { usePanels } from '../../store/panelsStore';
import type { SceneNode } from '../../types/scene';

/** The body's control script: JavaScript run once per physics step. */
export function ScriptEditorCard({ node }: { node: SceneNode }) {
  const updateNodeScript = useStore((s) => s.updateNodeScript);
  const openDocs = usePanels((s) => s.openDocs);
  const [scriptText, setScriptText] = useState(node.script || '');
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [showApiRef, setShowApiRef] = useState(false);

  // The editor follows the stored script, so the MCP bridge or an undo shows,
  // and starts over on another body. Only those — moving the body, or an edit
  // in another card, leaves an unsaved draft alone.
  const [shown, setShown] = useState({ id: node.id, script: node.script });
  if (node.id !== shown.id || node.script !== shown.script) {
    setShown({ id: node.id, script: node.script });
    setScriptText(node.script || '');
    setScriptError(null);
  }

  const handleSaveScript = useCallback(() => {
    try {
      if (scriptText.trim() !== '') {
        // Syntax compilation check
        new Function('api', scriptText);
      }
      setScriptError(null);
      updateNodeScript(node.id, scriptText);
    } catch (e) {
      setScriptError((e as Error).message || 'Compilation Error');
    }
  }, [node, scriptText, updateNodeScript]);

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2.5">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-semibold text-slate-800">
          <Code className="w-4 h-4 text-blue-500" />
          Component Script
          <button
            type="button"
            onClick={() => openDocs('tutorial')}
            className="ml-0.5 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold text-blue-600 bg-blue-50 border border-blue-200 hover:bg-blue-100 hover:border-blue-300 transition-colors cursor-pointer"
            title="Open the scripting tutorial"
          >
            <Info className="w-3.5 h-3.5" />
            Tutorial
          </button>
        </span>
        <div className="flex items-center gap-1.5">
          {node.script ? (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full border border-emerald-100 animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Active
            </span>
          ) : (
            <span className="text-[10px] font-medium text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded-full border border-slate-100">
              Disabled
            </span>
          )}
        </div>
      </h3>

      <p className="text-[10px] text-slate-400 -mt-1 leading-tight">
        Write custom real-time JavaScript to control this component at 1000Hz.
      </p>

      {/* Templates Selector */}
      <div className="flex items-center justify-between text-xs text-slate-500 gap-1.5 bg-slate-50 p-1.5 rounded-md border border-slate-100">
        <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Templates:</span>
        <select
          onChange={(e) => {
            const templateVal = e.target.value;
            if (templateVal === 'lqr') {
              setScriptText(`// Cartpole LQR Balancing Controller
const x = api.getJointPosition('cart_slide');
const v = api.getJointVelocity('cart_slide');
const theta = api.getJointPosition('pole_hinge');
const omega = api.getJointVelocity('pole_hinge');

// State-feedback LQR controller gains
const kx = 22.0;      // Cart position gain
const kv = 15.0;      // Cart velocity damping
const kTheta = 80.0;  // Pole angle gain (robust tracking)
const kOmega = 20.0;  // Pole angular velocity damping

// Compute the balancing force
const force = (kx * x) + (kv * v) + (kTheta * theta) + (kOmega * omega);

// Apply force directly to the cart slide joint
api.applyJointForce('cart_slide', force);
`);
            } else if (templateVal === 'sine') {
              setScriptText(`// Sinusoidal Driver
const forceX = Math.sin(api.getTime() * 5.0) * 8.0;
api.applyForce([forceX, 0, 0]);
`);
            } else if (templateVal === 'spring') {
              setScriptText(`// PD Harmonic Spring / Return-to-Center
const pos = api.getPosition();
const dist = 0.0 - pos[0];
const vel = api.getVelocity()[0];

// PD coefficients
const kp = 25.0; // Spring constant
const kd = 5.0;  // Damping

const force = (kp * dist) - (kd * vel);
api.applyForce([force, 0, 0]);
`);
            } else if (templateVal === 'clear') {
              setScriptText('');
            }
            e.target.value = ''; // Reset selection
          }}
          className="text-xs bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
        >
          <option value="">-- Select Template --</option>
          <option value="lqr">LQR Cartpole Balancer</option>
          <option value="sine">Sinusoidal Driver</option>
          <option value="spring">PD Harmonic Spring</option>
          <option value="clear">Clear Script</option>
        </select>
      </div>

      {/* Text Area Code Editor */}
      <div className="relative">
        <textarea
          value={scriptText}
          onChange={(e) => setScriptText(e.target.value)}
          placeholder="// Write control logic here... e.g. api.applyForce([10, 0, 0])"
          className="w-full h-40 font-mono text-[11px] leading-relaxed p-2.5 bg-slate-950 text-emerald-400 rounded-lg border border-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y shadow-inner"
          spellCheck={false}
        />
        <div className="absolute right-2.5 bottom-2.5 text-[8px] font-mono text-slate-600 bg-slate-900/50 px-1 rounded pointer-events-none select-none border border-slate-800">
          JS
        </div>
      </div>

      {/* Compilation Error Display */}
      {scriptError && (
        <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-[10px] flex gap-1.5 items-start leading-tight">
          <span className="font-bold shrink-0">⚠️ Error:</span>
          <span className="font-mono text-slate-700 break-all">{scriptError}</span>
        </div>
      )}

      {/* Control Actions Row */}
      <div className="flex gap-2 items-center justify-between">
        <button
          onClick={() => setShowApiRef(!showApiRef)}
          className="text-[10px] font-semibold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 cursor-pointer"
        >
          <Info className="w-3.5 h-3.5" />
          {showApiRef ? 'Hide API Reference' : 'Show API Reference'}
        </button>

        <button
          onClick={handleSaveScript}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-lg text-[11px] font-semibold shadow transition-colors flex items-center gap-1 cursor-pointer"
        >
          <Zap className="w-3.5 h-3.5" />
          Save & Execute
        </button>
      </div>

      {/* API Reference Collapsible */}
      {showApiRef && (
        <div className="text-[10px] bg-slate-50 border border-slate-150 rounded-lg p-2.5 flex flex-col gap-2 font-sans text-slate-600 max-h-64 overflow-y-auto">
          <div className="flex items-center justify-between border-b border-slate-200 pb-1 mb-1">
            <span className="font-semibold text-slate-700">Available API Methods</span>
            <button
              type="button"
              onClick={() => openDocs('apiref')}
              className="text-blue-600 hover:text-blue-700 font-semibold cursor-pointer"
            >
              Full reference →
            </button>
          </div>
          <p className="text-slate-400 leading-tight -mt-1">
            Runs once per physics step. <code className="font-mono">bodyName?</code> defaults to this component.
          </p>
          {[
            { group: 'Read body state', rows: [
              ['api.getPosition(bodyName?)', 'World position [x, y, z] in metres.'],
              ['api.getVelocity(bodyName?)', 'Linear velocity [vx, vy, vz] in m/s.'],
              ['api.getAngularVelocity(bodyName?)', 'Angular velocity [wx, wy, wz] in rad/s.'],
              ['api.getOrientation(bodyName?)', 'Rotation as a flat 9-element matrix.'],
              ['api.getMass(bodyName?)', 'Body mass in kg.'],
            ]},
            { group: 'Read joint state', rows: [
              ['api.getJointPosition(jointName)', 'Metres for slide, radians for hinge.'],
              ['api.getJointVelocity(jointName)', 'm/s for slide, rad/s for hinge.'],
            ]},
            { group: 'Apply forces', rows: [
              ['api.applyForce(forceVec, bodyName?)', 'World-space force [fx, fy, fz] in newtons.'],
              ['api.applyTorque(torqueVec, bodyName?)', 'World-space torque [tx, ty, tz] in N·m.'],
              ['api.applyJointForce(jointName, value)', 'Force/torque along the joint axis.'],
              ['api.setActuatorControl(name, ctrl)', 'Command a motor actuator.'],
            ]},
            { group: 'Override state', rows: [
              ['api.setPosition(pos, bodyName?)', 'Teleport. [x,y,z] for free, number for hinge/slide.'],
              ['api.setVelocity(vel, bodyName?)', 'Force a linear velocity, bypassing the solver.'],
              ['api.setAngularVelocity(v, bodyName?)', 'Force an angular velocity.'],
            ]},
            { group: 'Environment & utilities', rows: [
              ['api.getTime()', 'Simulation time in seconds.'],
              ['api.isKeyPressed(key)', "True while held: 'space', 'w', 'arrowup'…"],
              ['api.getWind()', 'Current wind as [windX, windY].'],
              ['api.log(msg)', 'Log to the browser console.'],
              ['api.id / api.name', "This component's id and display name."],
            ]},
          ].map(({ group, rows }) => (
            <div key={group} className="flex flex-col gap-1.5">
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mt-1">{group}</div>
              {rows.map(([sig, desc]) => (
                <div key={sig}>
                  <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">{sig}</code>
                  <p className="text-slate-500 mt-0.5">{desc}</p>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
