// Every panel in the properties sidebar should be able to point at an
// explainer. Tabs are grouped so the nav stays readable as the list grows.
export const DOCS_TABS = [
  { group: 'Simulation', items: [
    { id: 'gravity', label: '🪐 Gravity & Inertia' },
    { id: 'collision', label: '💥 Collision Physics' },
    { id: 'material', label: '🧪 Physical Material' },
    { id: 'friction', label: '🛷 Friction Controls' },
    { id: 'breaking', label: '💔 Breaking & Denting' },
  ]},
  { group: 'Bodies & Joints', items: [
    { id: 'launch', label: '🚀 Launch Velocity' },
    { id: 'damping', label: '🔗 Joint Damping' },
    { id: 'springs', label: '🌸 Springs & Limits' },
    { id: 'coupling', label: '⚙️ Joint Coupling' },
  ]},
  { group: 'Geometry', items: [
    { id: 'resize', label: '📏 Resize Component' },
    { id: 'offset', label: '📍 Position Offset' },
  ]},
  { group: 'Modelling', items: [
    { id: 'lattice', label: '🔲 Lattice Modelling' },
    { id: 'gestures', label: '⌨️ Scale, Bore & Modal Keys' },
  ]},
  { group: 'Fabrication', items: [
    { id: 'zeroing', label: '🎯 Machine Setup & Zeroing' },
    { id: 'resuming', label: '↩️ Stopping & Resuming' },
  ]},
  { group: 'Scripting', items: [
    { id: 'scripting', label: '💻 Names & Basics' },
    { id: 'tutorial', label: '🎓 Scripting Tutorial' },
    { id: 'apiref', label: '📚 Full API Reference' },
  ]},
  { group: 'Legal & Terms', items: [
    { id: 'license', label: '⚖️ License & Disclaimers' },
  ]},
] as const;

export type DocsTabId = typeof DOCS_TABS[number]['items'][number]['id'];
