import { create } from 'zustand';

interface SoundState {
  /** Off by default so simulation is completely silent until toggled in the header. */
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
  toggleSound: () => void;
}

export const useSoundStore = create<SoundState>((set) => ({
  soundEnabled: false,
  setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
  toggleSound: () => set((s) => ({ soundEnabled: !s.soundEnabled })),
}));
