// Whether the operator has put the job-pause dialog aside.
//
// The dialog (JobPauseModal) opens by itself whenever a job stops for something
// only a person can do — fit the next bit, swap the sheet. Hiding it is a
// choice about one stop, not about the rest of the job: the next stop is a new
// instruction and has to be seen. So what is remembered is *which* stop was
// hidden, and the dialog comes back for any other.

import { create } from 'zustand';

interface JobPauseState {
  /** The pause that was hidden, as `pauseKey` gave it, or null. */
  hiddenKey: string | null;
  hide: (key: string) => void;
  show: () => void;
}

/** One stop: the state it put the machine in and what it asked for. */
export function pauseKey(status: string, message: string | undefined): string {
  return `${status}|${message ?? ''}`;
}

export const useJobPause = create<JobPauseState>()((set) => ({
  hiddenKey: null,
  hide: (key) => set({ hiddenKey: key }),
  show: () => set({ hiddenKey: null }),
}));
