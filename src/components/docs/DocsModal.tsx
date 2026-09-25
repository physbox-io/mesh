import { Info, X } from 'lucide-react';
import { DOCS_TABS, type DocsTabId } from '../../utils/docsTabs';

/**
 * The reference guide. Every panel in the properties sidebar can deep-link
 * into one of its tabs through DocsInfoButton, which is why the active tab is
 * owned by the caller rather than held here.
 *
 * Mounted above the export modals (z-[60] against their z-50). Those render
 * later in App's DOM order and would otherwise paint over the docs they just
 * opened, so this has to stay mounted where App puts it.
 */
export function DocsModal({ tab, onTab, onClose }: {
  tab: DocsTabId;
  onTab: (tab: DocsTabId) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl max-w-4xl w-full max-h-[85dvh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-150 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <Info className="w-5 h-5 text-blue-500" />
            <h2 className="font-bold text-slate-800 text-base">PhysBox Reference Guide</h2>
          </div>
          <button aria-label="Close" title="Close" 
            onClick={() => onClose()}
            className="p-1 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Content Split */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Tab Navigation */}
          {/* The tab rail keeps every section reachable on a phone rather
              than collapsing into a picker, but at a width that leaves the
              prose it navigates worth reading. */}
          <div className="w-48 max-sm:w-28 bg-slate-50 border-r border-slate-150 p-3 max-sm:p-2 flex flex-col gap-1 shrink-0 overflow-y-auto">
            {DOCS_TABS.map(({ group, items }) => (
              <div key={group} className="flex flex-col gap-1 mb-1.5">
                <span className="px-1 pt-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-400">{group}</span>
                {items.map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => onTab(id)}
                    className={`px-3 py-1.5 text-left rounded-lg text-xs font-semibold transition-all ${tab === id ? 'bg-blue-500 text-white shadow' : 'text-slate-600 hover:bg-slate-100'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Tab Panel */}
          <div className="flex-1 p-6 max-sm:p-4 overflow-y-auto min-w-0">
            {tab === 'gravity' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🪐 Gravity, Active Joints & Inertia</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Gravity pulls downward along the Z axis. How a component reacts depends on its <strong>joints</strong> and <strong>inertia</strong>:
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">🌍 Static Elements (No Joints)</strong>
                    <p className="text-slate-500 mt-1">Shelves, pegs, and support structures have no joints. The solver treats them as having infinite mass welded directly to the world body, so gravity never moves them.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">⚙️ Hinge Gears (Rotational Hinge Joints)</strong>
                    <p className="text-slate-500 mt-1">A gear turns about a single pivot. Gravity acts through the pivot of a symmetrical gear, so it produces no torque about the axis and the gear does not turn on its own.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">📦 Unconstrained Bodies (Free Joints)</strong>
                    <p className="text-slate-500 mt-1">A body with a free joint moves in all six degrees of freedom and falls under gravity.</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'coupling' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">⚙️ Mechanical Joint Coupling</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Gears and pinion-racks are driven by a joint constraint rather than by tooth-on-tooth contact.
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">⚡ Tooth contact</strong>
                    <p className="text-slate-500 mt-1">Rigid teeth overlap slightly between time steps. Resolving those penetrations produces large impulses that make gears lock up, vibrate, or fly apart.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🔗 Joint coupling</strong>
                    <p className="text-slate-500 mt-1">A bilateral joint constraint ties the two joint rates together by the gear ratio, giving smooth and stable transmission at any speed.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🎯 Proximity</strong>
                    <p className="text-slate-500 mt-1">Gears and pinion-racks only couple when they are close enough to mesh. Untick <strong>Allow Mechanical Coupling</strong> in the sidebar to turn the constraint off for a body.</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'collision' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">💥 Solid and Ephemeral Bodies</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  A component can be a solid obstacle or a visual-only guide:
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">🛑 Solid Mode (Collision Enabled)</strong>
                    <p className="text-slate-500 mt-1">The body takes part in contact. It blocks and pushes other objects.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">👻 Ephemeral Mode (Collision Disabled)</strong>
                    <p className="text-slate-500 mt-1">Sets <code>contype="0"</code> and <code>conaffinity="0"</code>. Other bodies pass straight through it. Use it for decorative supports or visual guides.</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'breaking' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">💔 Breaking</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  A weld can be given a limit, past which it shears off and the part
                  falls away carrying the momentum it already had.
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">⚖️ What the numbers mean</strong>
                    <p className="text-slate-500 mt-1">
                      MuJoCo reports the force it is spending to hold every weld, so the
                      limits are real newtons rather than a made-up scale. A 1 kg body
                      hanging off a weld pulls about 10 N. A few hundred newtons is a
                      sturdy joint; a few tens is decorative.
                    </p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">↩️ Breaking is not an edit</strong>
                    <p className="text-slate-500 mt-1">
                      The saved scene still says the part is welded on, so nothing you
                      export or share is changed by a break, and it never enters the undo
                      history. <strong>Reset</strong> puts the object back together;
                      pausing does not, because a break you cannot stop and look at is no
                      use. <strong>Restore</strong> on a broken weld puts back that one
                      joint, where the body is now.
                    </p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🧱 Materials</strong>
                    <p className="text-slate-500 mt-1">
                      The <strong>Deformation</strong> card sets shattering and denting
                      together. Pick a material and it fills in numbers that belong
                      together, plus the density, so the body weighs what it is made of.
                      Glass shatters and never dents; steel dents and never shatters;
                      plastic and wood can do both. A material's breaking point is a
                      speed, so a glass marble and a glass tabletop both break from the
                      same drop. Glass, ceramic and stone also care how thick they are
                      where they are hit, so a wine glass breaks on its thin bowl from a
                      knock its foot would shrug off. Change any number and the material
                      becomes Custom.
                    </p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">💥 Shattering</strong>
                    <p className="text-slate-500 mt-1">
                      A brittle body breaks up when it takes a hard enough blow, measured
                      as <em>impulse</em> — momentum — rather than force, so the number
                      means the same thing whatever the solver is doing. A 200 g body
                      arriving at 5 m/s and stopping dead is about 1 N·s. The pieces are
                      cut from the body's own outline and add up to exactly what broke,
                      each carrying the velocity of the part of the body it used to be.
                    </p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🔨 Denting</strong>
                    <p className="text-slate-500 mt-1">
                      A surface with a yield takes a permanent crater from anything that
                      crosses it, and nothing at all from anything that does not — which
                      is the half worth watching for. Two identical weights dropped from
                      the same height onto the same plate, one hard and one soft, land
                      the same momentum over very different lengths of time, and only one
                      of them leaves a mark. The crater takes its width and its shape from
                      whatever made it — a flat-ended slug leaves a flat-bottomed pit its
                      own width — and spreads wider as well as deeper the harder the blow.
                      <strong> Dents are cosmetic:</strong> contact
                      keeps using the undented shape, because feeding a deformed mesh back
                      to the solver means rebuilding the model.
                    </p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🕳️ Piercing</strong>
                    <p className="text-slate-500 mt-1">
                      Past a second, higher limit a surface is not creased but holed: the
                      material under the striker is gone rather than pushed aside. Keep it
                      well above the yield, or there is no range left in which the thing
                      behaves like a sheet. Cosmetic in the same way a dent is — contact
                      keeps using the whole surface, so something can rest on the hole it
                      just made.
                    </p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">⚙️ Real damage, if you want it</strong>
                    <p className="text-slate-500 mt-1">
                      By default a dent or a hole is seen and not felt — contact goes on
                      using the undamaged shape. <strong>Damage is real, not just
                      seen</strong> changes that: things fall through the holes, and an
                      edge worn away stops holding what it used to. It is slow on purpose.
                      Damage reaches the solver by rebuilding the model, and the surface
                      then has to be broken into convex pieces as well, because MuJoCo
                      collides a mesh as its convex hull — and a hull fills every crater
                      and every hole straight back in, which would give you a body that
                      looks worn and collides like new.
                    </p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🪗 Crumple zones</strong>
                    <p className="text-slate-500 mt-1">
                      A hinge that is rigid until the torque on it passes a limit, and
                      then folds and <em>stays</em> folded — a car's crumple zone rather
                      than a spring. It costs almost nothing because it is not a new
                      mechanism: the joint is held still by a weld, and giving way is the
                      same release that shears a handle off. Note that a joint only folds
                      if something is still loading it afterwards; a post standing
                      straight up gives gravity no lever, so once its base yields it just
                      goes on standing there.
                    </p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">⏱️ Why there is a hold</strong>
                    <p className="text-slate-500 mt-1">
                      A hard contact makes the solver spike for a single step while it
                      resolves the overlap. A limit read one step at a time would snap
                      welds that were never really loaded, so the overload has to last a
                      few steps — about 3 ms — before it counts.
                    </p>
                  </div>
                </div>
              </div>
            )}

             {tab === 'friction' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🛷 Friction</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Friction coefficients set how easily objects slide against each other:
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">🌍 Floor Friction</strong>
                    <p className="text-slate-500 mt-1">The grip of the ground plane. 0.0 is frictionless; higher values give more traction.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">📦 Component Friction</strong>
                    <p className="text-slate-500 mt-1">The sliding friction coefficient of the selected body. Lower values slip more easily; higher values grip.</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'scripting' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">💻 Control Scripting & Joint Names</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Custom JavaScript control scripts run inside the physics solver loop on every physics time-step. To query state or apply forces, you pass string-based <strong>body names</strong> or <strong>joint names</strong> to the API.
                </p>
                
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-4">
                  <div className="text-xs">
                    <strong className="text-slate-800 font-semibold flex items-center gap-1">🏷️ Where do joint & body names come from?</strong>
                    <p className="text-slate-500 mt-1 leading-relaxed">
                      All names map directly to the values you configure in the <strong>Properties Panel</strong> when a component is selected:
                    </p>
                    <ul className="list-disc pl-4 mt-1.5 text-slate-500 flex flex-col gap-1">
                      <li><strong>Body Names:</strong> Equal to the <strong>Component Name</strong> at the top of the properties panel (e.g. <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"cart"</code> or <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"pole"</code>).</li>
                      <li><strong>Joint Names:</strong> Configured in the <strong>Joint Name (for API)</strong> text input under the <strong>🔗 Joint Type</strong> card (e.g. <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"cart_slide"</code> or <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"pole_hinge"</code>).</li>
                      <li><strong>Actuator/Motor Names:</strong> If you select "Enable Motor Drive", the actuator is automatically named by appending <code className="font-mono">_actuator</code> to the joint name (e.g. <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"cart_slide_actuator"</code>).</li>
                    </ul>
                  </div>

                   <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-800 font-semibold">🔄 Retrieving Sensor Data & Key Inputs</strong>
                    <p className="text-slate-500 mt-1 leading-relaxed">
                      Use the following API methods in your script:
                    </p>
                    <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// 1. Get positions & velocities of components in world space
const [x, y, z] = api.getPosition('cart');
const [vx, vy, vz] = api.getVelocity('cart');

// 2. Get joint-aligned values (highly recommended for controls)
const position = api.getJointPosition('cart_slide'); // Slider: meters, Hinge: radians
const velocity = api.getJointVelocity('cart_slide'); // Slider: m/s, Hinge: rad/s

// 3. Check if keyboard key is active (excluding editor inputs)
const isSpacePressed = api.isKeyPressed('space'); // Supports: 'space', 'w', 'arrowup', etc.`}
                    </pre>
                  </div>
 
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-800 font-semibold">⚡ Applying Forces & Modifying State</strong>
                    <p className="text-slate-500 mt-1 leading-relaxed">
                      Apply forces directly, command motors, or override position/velocity state:
                    </p>
                    <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// Apply torque or force aligned to the joint
api.applyJointForce('cart_slide', 15.5); // Applies linear force

// Command actuator motor velocity target
api.setActuatorControl('cart_slide_actuator', 1.0); // Drive cart at 1.0 m/s

// Directly set physical state (useful for resets or active launches)
api.setPosition([0, 0, 0.5], 'cart'); // Sets joint positions
api.setVelocity([0, 0, 5.0], 'cart'); // Sets linear velocities
api.setAngularVelocity([0, 15.0, 0], 'cart'); // Sets angular velocities`}
                    </pre>
                  </div>
                </div>
              </div>
            )}

            {tab === 'launch' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🚀 Launch Velocity & Launch Spin</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  These sliders set the <strong>initial conditions</strong> of a free body: the velocity it has at
                  the instant the simulation starts. They are not a continuous force: gravity, drag and contacts take over
                  immediately after t = 0. Press <strong>Reset</strong> to re-apply them.
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">➡️ Launch Velocity (m/s)</strong>
                    <p className="text-slate-500 mt-1">Linear velocity along each world axis. <strong>X</strong> is forward, <strong>Y</strong> is sideways, <strong>Z</strong> is up. Setting Z positive throws the body upward; it decelerates at <em>g</em> = 9.81 m/s² and peaks after <em>v/g</em> seconds.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🌀 Launch Spin (rad/s)</strong>
                    <p className="text-slate-500 mt-1">Angular velocity about each axis: <strong>Roll</strong> (X), <strong>Pitch</strong> (Y), <strong>Yaw</strong> (Z). One full turn per second is 2π ≈ 6.28 rad/s. Spin is conserved in free flight, so a tumbling body keeps tumbling until something touches it.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🎓 Why only free joints?</strong>
                    <p className="text-slate-500 mt-1">A free joint carries all 6 degrees of freedom, so all six numbers are meaningful. Hinge and slide joints have a single DOF, and their starting motion is set by the joint's own controls instead.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🧪 Try it</strong>
                    <p className="text-slate-500 mt-1">Give a ball X = 6 m/s and Z = 6 m/s for a classic 45° projectile arc. Add Pitch spin and increase <em>rolling friction</em> in Physical Material to see the spin bite when it lands.</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'damping' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🔗 Joint Damping</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Damping is a resistive force proportional to <strong>velocity</strong>, like friction in
                  a hinge or air resistance on a pendulum. It always opposes motion, so it removes energy from the system and
                  never adds any.
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">📐 The maths</strong>
                    <p className="text-slate-500 mt-1">The joint feels a force <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">F = −c·v</code>, where <em>c</em> is this slider. Doubling the value roughly halves the time an oscillation takes to die away.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🎚️ Choosing a value</strong>
                    <p className="text-slate-500 mt-1"><strong>0</strong> is a frictionless ideal joint that swings forever. Small values (0.1–1) give a realistic slowly-decaying pendulum. Large values (50+) make the joint feel like it is moving through treacle.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">📦 Free joints are different</strong>
                    <p className="text-slate-500 mt-1">On a free (6-DOF) body the slider tops out at 5.0 and acts as a general <strong>drag</strong> on both linear and angular motion, scaled by the body's own mass and inertia. It is a quick stand-in for air resistance.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">⚠️ Stability</strong>
                    <p className="text-slate-500 mt-1">Very large damping combined with a large timestep can overshoot and oscillate. If a joint starts buzzing, reduce damping before reaching for other fixes.</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'springs' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🌸 Joint Springs & Limits</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Springs pull a joint back toward a rest pose; limits stop it leaving a range entirely.
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">🌸 Spring Stiffness (K)</strong>
                    <p className="text-slate-500 mt-1">Restoring force per unit of displacement, <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">F = −K·(q − q₀)</code>. Higher K means a faster, tighter oscillation. With mass <em>m</em>, the natural frequency is <em>√(K/m)</em> rad/s.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🎯 Spring Rest Position (q₀)</strong>
                    <p className="text-slate-500 mt-1">The pose the spring pulls toward, in degrees for a hinge or metres for a slider. With K = 0 this has no effect at all.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🤝 Pair it with damping</strong>
                    <p className="text-slate-500 mt-1">A spring on its own oscillates forever. Add <strong>Joint Damping</strong> to get a realistic suspension: too little and it bounces, too much and it never returns. Critical damping is around <em>c = 2√(K·m)</em>.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🔒 Joint Limits</strong>
                    <p className="text-slate-500 mt-1">A hard range the joint cannot travel beyond, like a knee that will not bend backwards or a drawer that stops when closed. Limits are enforced by the constraint solver, so they hold firmly without needing a huge spring.</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'material' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🧪 Physical Material</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Every contact is modelled as a stiff <strong>spring-damper</strong>.
                  These six numbers shape that contact, and together they decide whether a body feels like steel, rubber or ice.
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">⏱️ Contact Stiffness (<code className="font-mono">solref[0]</code>)</strong>
                    <p className="text-slate-500 mt-1">The contact spring's <em>time constant</em> in seconds: how long it takes to correct a penetration. <strong>Lower is stiffer.</strong> Keep it at or above 5× the timestep (≈ 0.005 s); going lower makes contacts explosive and jittery.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🏀 Damping Ratio, Bounciness (<code className="font-mono">solref[1]</code>)</strong>
                    <p className="text-slate-500 mt-1"><strong>1.0</strong> is critically damped: the body lands dead with no bounce. Values below 1 are underdamped and bounce, and <strong>0</strong> bounces the most. Around <strong>0.2</strong> gives a lively rubber ball.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🧱 Contact Impedance (<code className="font-mono">solimp[0]</code>)</strong>
                    <p className="text-slate-500 mt-1">How strictly the solver enforces non-penetration, from 0 (soft and squishy) to 1 (rigid). Higher values mean less visible sinking under heavy loads, at the cost of a harder problem to solve. 0.99 is a good default.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🛷 Sliding Friction (<code className="font-mono">friction[0]</code>)</strong>
                    <p className="text-slate-500 mt-1">The classic Coulomb coefficient μ resisting tangential sliding. Ice is about 0.05, wood on wood about 0.4, rubber on tarmac over 1.0. A block only slides down a ramp once <em>tan θ &gt; μ</em>.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🔄 Torsional Friction (<code className="font-mono">friction[1]</code>)</strong>
                    <p className="text-slate-500 mt-1">Resists spinning about the contact normal, like a coin pirouetting on its face. Values are small. Raise it to stop tops spinning forever.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">⚽ Rolling Friction (<code className="font-mono">friction[2]</code>)</strong>
                    <p className="text-slate-500 mt-1">Resists rolling. Without it a perfect sphere on a flat plane rolls forever. Values are tiny; 0.0001 is usually enough to bring a ball to rest.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🤝 Contacts combine two bodies</strong>
                    <p className="text-slate-500 mt-1">Both surfaces contribute. A ball will not slide on a sticky floor no matter how slippery you make the ball, so check <strong>Floor Friction</strong> in the environment settings too.</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'resize' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">📏 Resize Component</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Resizing changes the geometry the solver collides against, so it has real physical consequences beyond looks.
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">📐 Half-sizes, not full sizes</strong>
                    <p className="text-slate-500 mt-1">Following MuJoCo's convention, box dimensions are <strong>half-extents</strong>: a size of 0.2 makes a box 0.4 m wide. Sphere size is a radius; a capsule takes a radius and a half-length.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">⚖️ Mass does not follow size</strong>
                    <p className="text-slate-500 mt-1">Mass is set independently, so scaling a body up leaves it just as heavy unless you change it. Real objects scale as the <strong>cube</strong> of length (double the size, eight times the mass), so adjust Mass to match.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🌀 Inertia is recomputed</strong>
                    <p className="text-slate-500 mt-1">The inertia tensor is derived from the geometry and mass, so a resized body genuinely becomes harder or easier to spin. A long thin rod resists rotation about its centre far more than a compact one.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🔗 Scale on compound bodies</strong>
                    <p className="text-slate-500 mt-1">The <strong>Scale</strong> card scales every sub-geom <em>and</em> their position offsets and child bodies together, so an assembly keeps its shape. The factor is a multiplier on the current size, and returns to 1× after each Apply. Turn two of the X/Y/Z buttons off to stretch one axis alone; a sphere or a cylinder, having no per-axis radius, takes the average.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">⌨️ Or press S in the viewport</strong>
                    <p className="text-slate-500 mt-1">With a body selected, <kbd className="font-mono">S</kbd> scales it by pointer, <kbd className="font-mono">X</kbd>/<kbd className="font-mono">Y</kbd>/<kbd className="font-mono">Z</kbd> confines it to one axis, and <kbd className="font-mono">I</kbd> hollows it out. Use the card when you want to type an exact figure. See <strong>Scale, Inset &amp; Modal Keys</strong>.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">⚠️ Very small geoms</strong>
                    <p className="text-slate-500 mt-1">Anything below roughly 0.01 m can slip through other objects between timesteps (tunnelling). Prefer scaling the whole scene up over making one part tiny.</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'offset' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">📍 Geom Position Offset</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  This moves a single <strong>geom</strong> within its body, rather than moving the body itself. It is the tool for
                  building compound shapes out of primitives.
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">🧩 Body frame vs world frame</strong>
                    <p className="text-slate-500 mt-1">The offset is measured in the body's own rotating frame. If the body tips over, the offset tips with it. <strong>Position Offset</strong> at the top of the panel moves the whole body in the world instead.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">⚖️ It shifts the centre of mass</strong>
                    <p className="text-slate-500 mt-1">A body's centre of mass is the mass-weighted average of its geoms. Pushing one heavy geom off to one side makes the body <strong>lopsided</strong>, so it will topple or swing rather than balance. This is how to build a weeble or a loaded die.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🔗 Joints stay put</strong>
                    <p className="text-slate-500 mt-1">Offsetting a geom does not move the body's joint anchor. Sliding mass away from a hinge increases the gravitational torque about it, which is how you tune a pendulum's period without touching the joint.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🧪 Try it</strong>
                    <p className="text-slate-500 mt-1">Add a second geom to a body, offset it upward, and give it a large mass. The body becomes top-heavy and will refuse to stand up.</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'lattice' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🔲 Lattice Modelling</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Lattice modelling is for crisp, dimensioned, hard-surface parts: a bracket, a housing, a mount,
                  anything that has to be exactly 40&nbsp;mm across and meet another part squarely. You place
                  points on a grid and build the shape by connecting them.
                </p>

                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">🧮 A vertex is three integers</strong>
                    <p className="text-slate-500 mt-1">Every corner sits on integer grid coordinates. Two corners with the same numbers are the same corner, so faces built at different times meet exactly, and mirroring is <code className="font-mono bg-slate-100 px-1 rounded">i → −i</code>.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">📏 The grid is decades: 0.1 / 1 / 10 / 100 mm</strong>
                    <p className="text-slate-500 mt-1">A corner placed on the 10&nbsp;mm grid is also on the 0.1&nbsp;mm grid. Lay a part out coarse, then switch to a finer grid for the details. Nothing already drawn moves.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">📄 The cage is the document</strong>
                    <p className="text-slate-500 mt-1">What you edit is the cage. The mesh on screen is derived from it: smoothed, walled, and recentred on its own centre of mass. A saved lattice body reopens with its cage intact. The smoothed mesh itself cannot be edited directly.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">✋ Nothing closes on its own</strong>
                    <p className="text-slate-500 mt-1">To finish a face, click back on the corner you started from (the cursor turns green), or press <kbd className="font-mono">Enter</kbd>. A face can have any number of corners.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🔴 Red means you are seeing the back of a face</strong>
                    <p className="text-slate-500 mt-1">The editor draws front faces only. A face drawn from the wrong side shows red and will be a hole in anything you export. Press <kbd className="font-mono">N</kbd> to turn every face the right way out, or <kbd className="font-mono">F</kbd> to flip the selected one.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">📐 Select something and type its size</strong>
                    <p className="text-slate-500 mt-1">Select a face, an edge, a loop or a few corners and the panel's <strong>Dimensions</strong> box shows its size and position in millimetres, per axis. Type a <em>size</em> to scale the selection about its own middle, so both ends move and the rest of the part stays put. Type an <em>at</em> value to move the whole selection there. Both snap to the grid.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🕳 Cut: holes at any diameter</strong>
                    <p className="text-slate-500 mt-1">Holes drawn on the grid have grid-sized diameters. For a bore at an exact size, such as 6.35&nbsp;mm for a bearing, use <strong>Cut</strong>. It subtracts a cylinder, box or sphere at a diameter you type. Select a face and the cut lands in the middle of it, square to the face at whatever angle it lies. Depth is measured into the material under the hole. Cut is available once the surface is closed or walled. The cage stays editable underneath, and a cut follows its face when you move it.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">⭕ Circles</strong>
                    <p className="text-slate-500 mt-1">The <strong>Circle</strong> tool (<kbd className="font-mono">4</kbd>) draws a polygon rounded to the grid; at 0.1&nbsp;mm it is within 0.05&nbsp;mm of a true arc. Click the centre, move out to size it, and click again. The <strong>Corners</strong> box sets how many sides: leave it on <em>auto</em> for a circle, or set 6 for a hex boss and 4 for a square post. The result is an ordinary face. Extrude it for a cylinder, bridge two of them for a taper, or type its diameter into <strong>Dimensions</strong>.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🔄 Revolve</strong>
                    <p className="text-slate-500 mt-1"><strong>Revolve</strong> sweeps a profile round an axis for turned features: a boss, a spigot, a knob, the bell of a funnel. Select a run of edges for a shell or one face for a solid, pick the axis, and press <em>Turn</em>. The distance from the profile to the axis is the radius, so move the profile to change it. A profile point on the axis becomes the pole, which gives a cone. Less than 360° leaves an arc, capped at both ends.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">🪚 Chamfer and fillet, on an edge of the solid</strong>
                    <p className="text-slate-500 mt-1">Select an edge (<kbd className="font-mono">L</kbd> selects its whole loop), put a radius in the panel's <strong>Edge radius</strong> box, and press <kbd className="font-mono">B</kbd> to chamfer it or <kbd className="font-mono">R</kbd> to round it. A chamfer keeps its flat under smoothing. A fillet is left soft, so a pass of smoothing rounds it to about the radius you asked for.</p>
                  </div>
                </div>

                <h4 className="font-bold text-slate-700 text-sm mt-1">A worked example: the shelf bracket</h4>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Load the <strong>Wall Bracket (Lattice)</strong> preset to see the finished part, or build one:
                </p>
                <ol className="text-xs text-slate-600 leading-relaxed list-decimal ml-4 flex flex-col gap-1.5">
                  <li>Drop in a <strong>Lattice</strong> body. It starts as a 40&nbsp;mm box of six quads.</li>
                  <li>Press <kbd className="font-mono">2</kbd> for <em>Select</em>, click the front face, then drag it with the <em>Extrude</em> tool (<kbd className="font-mono">3</kbd>). It moves in whole grid steps; the status bar counts the millimetres.</li>
                  <li>Set the grid to <strong>1&nbsp;mm</strong> for the details. The coarse corners stay exactly where they are.</li>
                  <li>Select the end face and press <kbd className="font-mono">I</kbd>, then move the pointer to size the inset and click. Extrude the inner face inward for a recess, or straight through for a slot.</li>
                  <li>Select an edge, press <kbd className="font-mono">L</kbd> to grow it to its whole loop, then <kbd className="font-mono">H</kbd> to hold it sharp. Turn <strong>Smoothing</strong> to 1×: the corners round and the marked edges stay crisp.</li>
                  <li>Check the panel's <strong>Surface is closed</strong> line. Exports and Cut need a closed surface; give it a <strong>Wall</strong> or cap it by hand.</li>
                </ol>

                <div className="bg-amber-50 border border-amber-200/70 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-amber-800">🖌️ Lattice and sculpting on the same body</strong>
                    <p className="text-amber-900/70 mt-1">
                      The cage rebuilds the mesh on every edit, so sculpting on a live cage would be lost the next
                      time a face moved. Pressing <strong>Sculpt</strong> on a lattice body therefore
                      <strong> applies the lattice</strong> first: the mesh becomes its own document, the lattice tools
                      close for that body, and the cage stays in the file without driving anything.
                      <strong> Ctrl+Z puts it all back.</strong> A sculpted mesh cannot be turned back into a cage.
                    </p>
                  </div>
                </div>

                <div className="bg-sky-50 border border-sky-200/70 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-sky-800">✂️ Cutting sculpted clay</strong>
                    <p className="text-sky-900/70 mt-1">
                      The sculpt panel's <strong>Scissors</strong> (key <kbd className="font-mono">7</kbd>) cut straight
                      through along your view. Drag a loop: everything inside it goes. A loop in the middle of the model
                      makes a hole; a loop over its edge cuts that piece off, and the loop can start off the model.
                      Hold <kbd className="font-mono">Ctrl</kbd> to keep only the inside instead. <strong>Fill cut</strong> closes
                      the cut with a new face so the clay stays solid; turn it off to leave the hole open and see inside,
                      but an open surface will not print. The body stays a sculpt, and <strong>Ctrl+Z</strong> undoes a cut
                      like a stroke. A cut that splits the clay makes <strong>one body per piece</strong>: press Done, then
                      select a piece to move or delete it on its own.
                    </p>
                  </div>
                </div>

                <h4 className="font-bold text-slate-700 text-sm mt-1">Every key</h4>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                  {[
                    ['1 2 3', 'Place, Select, Extrude'],
                    ['X Y Z', 'Turn the work plane; it lands on whatever the pointer is on'],
                    ['[ ]', 'Move the plane a step along its axis (Shift for five, Alt for 0.1 mm)'],
                    ['Alt (hold)', 'Snap to 0.1 mm instead of the grid while dragging or clicking'],
                    ['Ctrl (hold)', 'Stay on the plane you are pointing at'],
                    ['Click / Enter', 'Close the polygon being drawn'],
                    ['Shift / Ctrl+click', 'Add a corner, face or edge to the selection'],
                    ['Drag', 'Box-select corners; Shift adds to what is selected'],
                    ['L', 'Grow a selected edge to its whole loop'],
                    ['S', 'Scale the selection (then X/Y/Z to hold one axis)'],
                    ['I', 'Inset a face, sized by the pointer'],
                    ['B', 'Bevel: cut the corners off a face'],
                    ['J', 'Join two selected faces, or bore a tunnel between them'],
                    ['H', 'Hold an edge sharp under smoothing'],
                    ['F / N', 'Flip one face / turn every face the right way out'],
                    ['Del', 'Remove the corner under the pointer, or the selection'],
                    ['Ctrl+Z', 'Undo (Shift to redo)'],
                  ].map(([combo, what]) => (
                    <div key={combo} className="contents">
                      <kbd className="font-mono font-semibold text-slate-700 whitespace-nowrap">{combo}</kbd>
                      <span className="text-slate-500">{what}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'gestures' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">⌨️ Scale, Inset &amp; Modal Keys</h3>
                <div className="bg-amber-50 border border-amber-200/70 rounded-xl p-4 text-xs">
                  <strong className="text-slate-700">📐 Measuring: <kbd className="font-mono">D</kbd> for a distance, <kbd className="font-mono">A</kbd> for an angle</strong>
                  <p className="text-slate-500 mt-1">
                    Two clicks give a distance and its per-axis parts; three give the angle at the middle one.
                    Each click snaps to the nearest feature: a corner, the midpoint of an edge, the axis of a
                    cylinder, or the centre of a circle the neighbouring vertices lie on. Hole centres snap
                    this way on boolean results too.
                    Click away from the model or press <kbd className="font-mono">Esc</kbd> to clear the reading;
                    <kbd className="font-mono"> Esc</kbd> again puts the tape away. The viewport still orbits on
                    the right mouse button throughout.
                  </p>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Scale and inset need a <strong>size</strong>. The key starts the operation and the pointer sizes
                  it live. Nothing is held down while you move.
                </p>

                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">1. Press the key</strong>
                    <p className="text-slate-500 mt-1"><kbd className="font-mono">S</kbd> to scale, <kbd className="font-mono">I</kbd> to inset. The gesture starts at 1× wherever the pointer is.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">2. Move the pointer</strong>
                    <p className="text-slate-500 mt-1">Move away from the middle to grow (a wider inset, a bigger body) and back towards it to shrink. The <strong>status bar</strong> along the bottom shows which gesture is running and how far it has gone, for example <em>Scale 1.25× · Z</em>.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">3. Confine it, if you want</strong>
                    <p className="text-slate-500 mt-1">Press <kbd className="font-mono">X</kbd>, <kbd className="font-mono">Y</kbd> or <kbd className="font-mono">Z</kbd> to scale along that world axis alone. Press the same key again to free the other two.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">4. Keep it or put it back</strong>
                    <p className="text-slate-500 mt-1"><strong>Click</strong> or <kbd className="font-mono">Enter</kbd> keeps it; <strong>right-click</strong> or <kbd className="font-mono">Esc</kbd> puts everything back as it was. A cancelled gesture adds no undo step.</p>
                  </div>
                </div>

                <h4 className="font-bold text-slate-700 text-sm mt-1">What they do where</h4>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">S on an ordinary body</strong>
                    <p className="text-slate-500 mt-1">Scales the selected body and everything parented under it (mesh vertices, primitive sizes, geom offsets and child positions), so an assembly keeps its shape. To type an exact figure instead, use the <strong>Scale</strong> card in the sidebar.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">I on an ordinary body: boring a hole</strong>
                    <p className="text-slate-500 mt-1">Puts a scaled copy of the body's own shape inside it, marked as a boolean <strong>hole</strong>, running right through: a cylinder becomes a pipe, a box becomes a square tube. The red ghost is the hole. Move the pointer out to widen it, and press <kbd className="font-mono">X</kbd>, <kbd className="font-mono">Y</kbd> or <kbd className="font-mono">Z</kbd> to change which way it runs (Z by default).</p>
                    <p className="text-slate-500 mt-1">For a tray or a cup, bore it and then shorten the negative in the sidebar. It is an ordinary geom afterwards, with its own size, position and operator. Deleting it gives the solid back.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">S and I inside the lattice tools</strong>
                    <p className="text-slate-500 mt-1">They act on the selected faces or corners rather than on the whole body. Scale moves corners in whole grid steps about the middle of the selection; inset makes a smaller face inside a selected one, ringed by quads. See the <strong>Lattice Modelling</strong> page.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">📍 Which mode has the keyboard</strong>
                    <p className="text-slate-500 mt-1">The chip at the far left of the status bar always says: <em>Select</em>, <em>Grab</em>, <em>Lattice · Extrude</em>, <em>Sculpt · Smooth</em>, or the gesture in progress. Check it when you are unsure which mode has the keyboard.</p>
                  </div>
                </div>

                <h4 className="font-bold text-slate-700 text-sm mt-1">Try it: a pipe in four seconds</h4>
                <ol className="text-xs text-slate-600 leading-relaxed list-decimal ml-4 flex flex-col gap-1.5">
                  <li>Drop a <strong>cylinder</strong> into the scene and leave it selected.</li>
                  <li>Press <kbd className="font-mono">S</kbd>, pull the pointer out to make it taller and wider, click to keep it.</li>
                  <li>Press <kbd className="font-mono">I</kbd> and move the pointer <em>out</em> until the red ghost is the bore you want. Click.</li>
                  <li>The body is now a boolean: solid minus a copy of itself that runs right through it. Give it a moment to build, then look at the <strong>Boolean</strong> card in the sidebar to choose how it should collide.</li>
                </ol>
              </div>
            )}


            {tab === 'tutorial' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🎓 Scripting Tutorial</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  A component script is a snippet of JavaScript that runs <strong>once per physics step</strong> (about 1000×
                  per second) for the body it is attached to.
                </p>

                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-4">
                  <div className="text-xs">
                    <strong className="text-slate-800 font-semibold">1️⃣ Your first script</strong>
                    <p className="text-slate-500 mt-1 leading-relaxed">
                      Select a body, paste this, and press <strong>Save &amp; Execute</strong>. There is no <code className="font-mono">function</code> wrapper
                      and no <code className="font-mono">return</code>; the script body is the loop.
                    </p>
                    <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// Push this body steadily along +X, forever.
api.applyForce([5, 0, 0]);`}
                    </pre>
                    <p className="text-slate-500 mt-1.5 leading-relaxed">
                      The body accelerates rather than moving at constant speed, since a constant force gives constant
                      acceleration (<em>F = ma</em>).
                    </p>
                  </div>

                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-800 font-semibold">2️⃣ Read state, then react</strong>
                    <p className="text-slate-500 mt-1 leading-relaxed">
                      Every call without a body name refers to the body the script is attached to.
                    </p>
                    <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// A hovering thruster: hold this body at z = 3 m.
const [x, y, z] = api.getPosition();
const [vx, vy, vz] = api.getVelocity();

const kp = 40.0;   // how hard to correct height error
const kd = 10.0;   // how hard to resist vertical speed
const mass = api.getMass();

// Cancel gravity, then add the correction on top.
const hold = mass * 9.81;
const correct = kp * (3.0 - z) - kd * vz;

api.applyForce([0, 0, hold + correct]);`}
                    </pre>
                  </div>

                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-800 font-semibold">3️⃣ Understanding PD control</strong>
                    <p className="text-slate-500 mt-1 leading-relaxed">
                      The pattern <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">kp × (target − actual) − kd × velocity</code> is a
                      <strong> PD controller</strong>. It covers most control tasks.
                    </p>
                    <ul className="list-disc pl-4 mt-1.5 text-slate-500 flex flex-col gap-1">
                      <li><strong>kp</strong> (proportional) pulls toward the target. Too high and it overshoots and oscillates.</li>
                      <li><strong>kd</strong> (derivative) opposes motion and damps that oscillation. Too high and it becomes sluggish.</li>
                      <li>Tune <strong>kp first</strong> until it reaches the target briskly, then raise kd until the wobble stops.</li>
                    </ul>
                  </div>

                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-800 font-semibold">4️⃣ Driving joints and motors</strong>
                    <p className="text-slate-500 mt-1 leading-relaxed">
                      For jointed mechanisms, work in joint space: one number instead of three vectors. Joint names come
                      from the <strong>Joint Name (for API)</strong> field; actuators append <code className="font-mono">_actuator</code>.
                    </p>
                    <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// Hold a hinge at 45 degrees using a PD law.
const target = 45 * Math.PI / 180;   // API angles are RADIANS
const q  = api.getJointPosition('arm_hinge');
const qd = api.getJointVelocity('arm_hinge');

api.applyJointForce('arm_hinge', 60 * (target - q) - 8 * qd);

// Or, if the joint has "Enable Motor Drive" ticked:
api.setActuatorControl('arm_hinge_actuator', target);`}
                    </pre>
                  </div>

                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-800 font-semibold">5️⃣ Keyboard input &amp; time</strong>
                    <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// Drive with the arrow keys; jump on space.
let fx = 0;
if (api.isKeyPressed('arrowleft'))  fx -= 20;
if (api.isKeyPressed('arrowright')) fx += 20;
api.applyForce([fx, 0, 0]);

if (api.isKeyPressed('space') && api.getPosition()[2] < 0.3) {
  api.setVelocity([0, 0, 4.0]);
}

// getTime() is SIMULATION time, so it is unaffected by frame rate.
const wobble = Math.sin(api.getTime() * 4) * 3;`}
                    </pre>
                  </div>

                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-800 font-semibold">⚠️ Pitfalls worth knowing</strong>
                    <ul className="list-disc pl-4 mt-1.5 text-slate-500 flex flex-col gap-1">
                      <li><strong>Forces vs state.</strong> <code className="font-mono">applyForce</code> asks the solver politely; <code className="font-mono">setVelocity</code> overrides physics outright. Prefer forces unless you are teleporting or resetting.</li>
                      <li><strong>Angles are radians.</strong> Multiply degrees by <code className="font-mono">Math.PI / 180</code>.</li>
                      <li><strong>Forces do not accumulate across steps.</strong> Applied force is cleared each step, so a force you want held must be re-applied every step. Your script already runs every step, so this happens naturally.</li>
                      <li><strong>Keep it cheap.</strong> This runs ~1000×/second. Avoid allocating large arrays or doing heavy work per step.</li>
                      <li><strong>Errors are silent-ish.</strong> A throwing script is caught and logged to the browser console rather than halting the sim. Use <code className="font-mono">api.log()</code> and open DevTools if nothing seems to happen.</li>
                      <li><strong>Gravity is still on.</strong> To hover you must actively cancel weight (<em>m·g</em>), as in the example above.</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {tab === 'apiref' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">📚 Full Script API Reference</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Every method available on <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api</code> inside a component script.
                  Arguments marked <code className="font-mono">?</code> are optional; where a <code className="font-mono">bodyName</code> is
                  omitted it defaults to the body the script is attached to.
                </p>

                {[
                  {
                    title: '📖 Reading body state',
                    rows: [
                      ['api.getPosition(bodyName?)', 'World position as [x, y, z], in metres.'],
                      ['api.getVelocity(bodyName?)', 'Linear velocity as [vx, vy, vz], in m/s.'],
                      ['api.getAngularVelocity(bodyName?)', 'Angular velocity as [wx, wy, wz], in rad/s.'],
                      ['api.getOrientation(bodyName?)', 'Orientation as a flat 9-element row-major rotation matrix.'],
                      ['api.getMass(bodyName?)', 'Body mass in kg, as computed from its geoms.'],
                    ],
                  },
                  {
                    title: '📖 Reading joint state',
                    rows: [
                      ['api.getJointPosition(jointName)', 'Joint coordinate: metres for a slide, radians for a hinge.'],
                      ['api.getJointVelocity(jointName)', 'Joint rate: m/s for a slide, rad/s for a hinge.'],
                    ],
                  },
                  {
                    title: '⚡ Applying forces',
                    rows: [
                      ['api.applyForce(forceVec, bodyName?)', 'Adds a world-space force [fx, fy, fz] in newtons for this step.'],
                      ['api.applyTorque(torqueVec, bodyName?)', 'Adds a world-space torque [tx, ty, tz] in N·m for this step.'],
                      ['api.applyJointForce(jointName, value)', 'Adds force/torque along a joint axis. The usual choice for control.'],
                      ['api.setActuatorControl(actuatorName, ctrl)', 'Sets the control input of a motor actuator (jointName + "_actuator").'],
                    ],
                  },
                  {
                    title: '🎯 Overriding state directly',
                    rows: [
                      ['api.setPosition(pos, bodyName?)', 'Teleports the body. Free joints take [x, y, z]; hinge/slide take a single number.'],
                      ['api.setVelocity(vel, bodyName?)', 'Overrides linear velocity, bypassing the solver.'],
                      ['api.setAngularVelocity(angvel, bodyName?)', 'Overrides angular velocity. Free/ball take a vector, hinge takes a number.'],
                    ],
                  },
                  {
                    title: '🌍 Environment & utilities',
                    rows: [
                      ['api.getTime()', 'Elapsed simulation time in seconds (not wall-clock time).'],
                      ['api.isKeyPressed(key)', "True while a key is held: 'space', 'w', 'arrowup', … Ignores typing in editors."],
                      ['api.getWind()', 'Current wind as [windX, windY].'],
                      ['api.log(msg)', 'Logs to the browser console, prefixed with the component name.'],
                      ['api.id / api.name', "This component's id and display name, as strings."],
                    ],
                  },
                ].map(({ title, rows }) => (
                  <div key={title} className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-2.5">
                    <strong className="text-slate-800 font-semibold text-xs">{title}</strong>
                    {rows.map(([sig, desc]) => (
                      <div key={sig} className="text-xs border-t border-slate-150 pt-2 first:border-t-0 first:pt-0">
                        <code className="font-mono text-[10px] text-blue-600 bg-blue-50 px-1 py-0.5 rounded border border-blue-100">{sig}</code>
                        <p className="text-slate-500 mt-1 leading-relaxed">{desc}</p>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {tab === 'zeroing' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🎯 Machine Setup &amp; Zeroing</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Before any laser or CNC job you have to tell the machine where the work actually is. The
                  export modals do this under <strong>Set Work Origin</strong>, which appears once a machine
                  is connected over USB. The origin is the near-left corner of your stock that the G-code
                  treats as X0 Y0 Z0. Get it wrong and the job cuts in the wrong place, or into the bed.
                </p>
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">1️⃣ Home first ($H)</strong>
                    <p className="text-slate-500 mt-1">Homing establishes machine coordinates against the limit switches. Everything below sets a <em>work</em> offset (G54) on top of that, so homing after zeroing keeps the origin. A soft reset does too.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">2️⃣ Jog X/Y to the origin</strong>
                    <p className="text-slate-500 mt-1">Use the arrow pad to drive the tool over the point on your stock that should be X0 Y0. Steps are 0.1 / 1 / 10 mm. Take the last approach at 0.1 mm and sight down the tool. The red ⏹ button cancels a jog in flight. Then press <strong>Set XY Zero Here</strong>, and <strong>Go To Zero</strong> to confirm it landed where you meant.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">3️⃣ Zero Z, by hand or on a plate</strong>
                    <p className="text-slate-500 mt-1"><strong>By hand</strong> works on any machine and any material, and needs nothing but the bit: jog Z down at 0.1 mm until the tip just marks the surface, or just nips a slip of paper, and press <strong>Set Z Zero Here</strong>. If something is under the tip, enter its thickness in the <em>gauge</em> box (paper is about 0.1 mm, a 1‑2‑3 block is 25.4) and zero lands on the material rather than on the gauge. Nothing moves: the machine is only being told where it already is.</p>
                    <p className="text-slate-500 mt-1"><strong>On a plate</strong> is more repeatable but needs a touch plate, a clip and stock the circuit can see. Clip the lead to the tool, sit the plate on the stock's top face, and touch the tool to the plate by hand until the probe light under the buttons turns green: that proves the circuit, and the probe is refused until it has been seen to close on this connection. Then park the tool a few mm above the plate, enter your plate's real thickness, and press <strong>Probe Z Zero</strong>. <strong>Remove the plate before cutting.</strong></p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">4️⃣ Set the spindle speed by hand</strong>
                    <p className="text-slate-500 mt-1">On a trim router or a VFD-and-a-dial spindle the <code>S</code> word in the G-code does nothing. The speed is a knob, and it stays wherever the last job left it. Each export modal states the number under <strong>Before You Start</strong> once a machine is connected, and writes it into the file as a comment. It is worked out from the material you picked and the cutter's diameter (surface speed ÷ diameter), so change the material and the number moves.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">5️⃣ Frame, then cut</strong>
                    <p className="text-slate-500 mt-1">Frame Job traces the outline at low power so you can check the job fits the stock. For routing, Probe Bed measures a grid across the job so cut depth follows a bed that is not flat.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">6️⃣ Pausing, and re-zeroing after a tool change</strong>
                    <p className="text-slate-500 mt-1"><strong>Pause</strong> is a feed hold: the machine decelerates along the path and keeps its position, so <strong>Resume</strong> picks the cut up exactly where it stopped. <strong>E‑Stop</strong> is a soft reset: it drops the position, and a part that has been cut into cannot be re-registered.</p>
                    <p className="text-slate-500 mt-1"><strong>Live Trim</strong> appears while the job runs. It nudges the feed and the spindle on the motion already in the buffer, so a cut that is chattering or burning can be backed off without stopping. Burn marks mean the feed and the speed are mismatched; trim until it sounds right, then set those numbers for next time.</p>
                    <p className="text-slate-500 mt-1">A job that changes tools stops on its own and says which bit to fit. The new bit is a different length, so the Z datum from the old one is wrong. Resume stays disabled until you have zeroed Z again, by either route, from the pause banner.</p>
                  </div>
                </div>
                <div className="bg-amber-50 border border-amber-200/60 rounded-xl p-4 flex flex-col gap-2.5">
                  <strong className="text-amber-800 font-semibold text-xs">⚠️ If the probe misses</strong>
                  <p className="text-amber-700/80 text-xs leading-relaxed">
                    A probe that runs its full travel without touching (clip off, lead broken, plate not
                    under the tool) <strong>does not set Z zero</strong>, and says so in red. Zeroing on a
                    missed probe would put the stock surface wherever the tool ran to, and the next cut would
                    plunge that far past it. Fix the probe and run it again before starting the job.
                    The search is 10 mm, so a probe that does not stop drives at most that far; and it is
                    not started at all until the circuit has been seen to close, or while the input already
                    reads closed with the tool in the air (a shorted lead, or $6 set the wrong way).
                  </p>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Requires a Chromium browser (WebSerial) and GRBL-compatible firmware: GRBL 1.1, FluidNC,
                  or grblHAL. The plate thickness field defaults to 12 mm; set it to your own plate's
                  measured thickness before the first cut. If you have no probe wired up, use the
                  manual route above; nothing else in the app needs one.
                  Connecting a machine also reads its <code>$$</code> settings, so the job-time
                  estimates switch from an assumed acceleration to your own <code>$120</code>-
                  <code>$122</code> and rapid rates, and the spindle recommendation is bounded by
                  your <code>$30</code>/<code>$31</code>.
                </p>
              </div>
            )}

            {tab === 'resuming' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">↩️ Stopping &amp; Resuming a Job</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  A relief carve or a deep pocket can run for most of a day. This is what happens
                  when one of those does not get to the end — because the cutter broke, because
                  the USB lead was nudged, or because the laptop went to sleep at hour six.
                </p>

                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                  <div className="text-xs">
                    <strong className="text-slate-700">Pause vs. Park vs. E‑Stop</strong>
                    <p className="text-slate-500 mt-1"><strong>Pause</strong> is a feed hold: the machine decelerates along its path and keeps its position, so Resume carries on exactly where it stopped. <strong>Park</strong> goes further — it stops, notes the line it had actually finished, retracts, and lets go, so you can jog the machine anywhere, change a bit or brush the work out, then put it back. <strong>E‑Stop</strong> is a soft reset: it drops the position, and a part that has been cut into cannot be re-registered from it.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">Resuming from a line</strong>
                    <p className="text-slate-500 mt-1">Line eleven thousand of a G‑code file means nothing on its own: the units, the coordinate system, the feed, the spindle speed and the depth the tool should be at were all set thousands of lines earlier. So the program is replayed without being sent, and a short preamble puts the machine back into that state — retract, spindle up to speed, move over the point it stopped at, then descend into the cut at a feedrate rather than a rapid. The banner names the depth it will descend to. Check that against the piece in front of you.</p>
                    <p className="text-slate-500 mt-1">The line is an editable field, not a fait accompli. Winding it back a little recuts a short stretch of finished surface, which is almost always safer than trying to land exactly on the break.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">Closing the laptop, and power cuts</strong>
                    <p className="text-slate-500 mt-1">When the browser streams the job over USB, the tab is doing the work: it sends a line at a time and waits for the controller to acknowledge it. A laptop that sleeps stops sending, the USB device re-enumerates when it wakes, and the cut ends wherever the controller’s buffer ran out. <strong>So you cannot sleep the machine and expect the cut to continue.</strong></p>
                    <p className="text-slate-500 mt-1">What you can do is pick it up afterwards. The program and the line it reached are written to this browser’s storage as it runs, so after a crash, a closed tab or a power cut you are offered the job again — on load, and whenever you come back to the tab. The offer is only good while <strong>the work is still clamped where it was</strong>. Home the machine, confirm the work origin, and zero Z for whatever bit is actually in the spindle before you take it.</p>
                    <p className="text-slate-500 mt-1">Very large programs — a fine‑stepover relief is hundreds of thousands of lines — do not fit in a browser’s storage. The pause banner says so while the job runs. <strong>PhysBox Pro</strong> keeps the program in your account instead, where size is not the limit, which also means you can pick the job up from a different computer. The line is recorded to the account once a minute rather than every two seconds, so a cloud recovery may be slightly behind the cut — wind it back, not forward.</p>
                  </div>
                  <div className="text-xs border-t border-slate-150 pt-3">
                    <strong className="text-slate-700">The way that really does survive a closed lid</strong>
                    <p className="text-slate-500 mt-1">A job sent to a <strong>Tekno Box</strong> is handed over whole: the device streams it to the controller itself, and the browser is only watching. Close the laptop, shut it down, drive home — the cut carries on. That is the right answer for anything that runs for hours. The machine itself still has to stay powered.</p>
                  </div>
                </div>

                <div className="bg-amber-50 border border-amber-200/60 rounded-xl p-4 flex flex-col gap-2.5">
                  <strong className="text-amber-800 font-semibold text-xs">⚠️ What a resume cannot know</strong>
                  <p className="text-amber-700/80 text-xs leading-relaxed">
                    It replays the program, not the workshop. It does not know that the stock was
                    unbolted and put back, that a different bit went in, or that the piece moved when
                    the cutter snapped. If any of those happened, the preamble will drive the tool to
                    a depth that was correct for a piece that no longer exists. A program that used
                    <code>G92</code>, <code>G28</code> or <code>G30</code> is flagged as uncertain for
                    the same reason, rather than being resumed into a fiction.
                  </p>
                </div>
              </div>
            )}

            {tab === 'license' && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">⚖️ License &amp; Terms</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  PhysBox Mesh is distributed under the <strong>PhysBox Permissive Public License (PPPL-1.0)</strong>.
                  Commercial use of generated 3D meshes, STL models, contour slices, relief carving toolpaths, and fabricated goods is fully permitted with attribution.
                </p>
                <div className="bg-slate-100 p-3.5 rounded-xl border border-slate-200 text-[11px] font-mono text-slate-700 whitespace-pre-wrap leading-relaxed max-h-[50vh] overflow-y-auto">
{`PhysBox Permissive Public License (PPPL-1.0)
Copyright (c) 2026 PhysBox Contributors and Authors. All Rights Reserved.

1. PERMISSION AND SCOPE
Permission is granted to access, execute, and use the Software for personal, educational, research, and commercial purposes, including the generation, export, and commercial utilization of output artifacts (such as 3D meshes, CAD models, STL files, SVG paths, toolpaths, CNC G-code, and laser/router instructions).

2. PERMITTED COMMERCIAL USE OF OUTPUTS
You are fully permitted to design, prototype, simulate, 3D print, CNC machine, sell, and monetize any physical workpieces or digital models produced using the Software.

3. ATTRIBUTION & RESTRICTIONS ON SOFTWARE FORKING
(a) Attribution: The copyright notice and license must be retained in all copies or substantial portions of the Software.
(b) No Standalone Forking or Hosted Service Redistribution: You may NOT redistribute, sublicense, re-brand, or host the Software source as a competing standalone service or software fork without explicit prior written authorization.
(c) Brand Protection: The names "PhysBox", "Etch", "Volt", "Mesh", "Flux", or the names of their contributors may not be used to endorse or promote third-party products without specific prior written permission.

4. STRICT DISCLAIMER OF LIABILITY & PHYSICAL MACHINERY WARNING
THE SOFTWARE, PHYSICS SOLVERS, CSG COMPILERS, TOOLPATH CALCULATORS, AND MACHINE CONTROLLERS ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CNC/LASER DAMAGE, SPINDLE CRASHES, 3D PRINTER HEAD CRASHES, FIRE, MATERIAL LOSS, BUSINESS INTERRUPTION, OR BODILY INJURY RESULTING FROM OPERATION OF MACHINERY. OPERATORS ASSUME SOLE RESPONSIBILITY FOR VERIFYING G-CODE, CLAMPING, TRAVEL LIMITS, EYE PROTECTION, AND PHYSICAL SAFETY.`}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
