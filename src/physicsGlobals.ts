import type { ComponentProps, ComponentRef } from 'react';
import type * as THREE from 'three';
import type { EffectComposer } from '@react-three/postprocessing';
import type AICopilotPanel from './components/AICopilotPanel';
import type { NoteCard } from './utils/noteCards';
import { useStore } from './store/useStore';

// AICopilotPanel keeps its ChatMessage type to itself; this is the same type,
// read back off its props so the two cannot drift.
export type CopilotMessage = NonNullable<ComponentProps<typeof AICopilotPanel>['messages']>[number];

// Globals other modules (the MCP bridge, the note-card manager, tests) reach
// through `window`. Typed here rather than declared globally so a differently
// typed declaration elsewhere cannot conflict with this one.
export interface PhysicsGlobals {
  DISABLE_USEFRAME?: boolean;
  _physics_getNoteCards?: () => NoteCard[];
  _physics_setNoteCards?: (cards: NoteCard[]) => void;
  _physics_getCopilotMessages?: () => CopilotMessage[];
  _physics_setCopilotMessages?: (msgs: CopilotMessage[]) => void;
  _physics_store?: typeof useStore;
  _physics_gl?: THREE.WebGLRenderer;
  _physics_scene?: THREE.Scene;
  _physics_camera?: THREE.Camera;
  _physics_composer?: ComponentRef<typeof EffectComposer> | null;
}
export const physicsGlobals = (typeof window !== 'undefined' ? window : {}) as unknown as PhysicsGlobals;

declare global {
  interface Window { useStore?: typeof useStore }
}
// Debug hook: the store is reachable from the browser console.
if (typeof window !== 'undefined') {
  window.useStore = useStore;
}
