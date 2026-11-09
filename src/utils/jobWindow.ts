import { useStore } from '../store/useStore';

/** How many windows showing a job's progress are mounted (each `JobProgress`). */
let jobWindows = 0;

/** Counts a mounted job window; returns its unregister, for a mount effect. */
export function registerJobWindow(): () => void {
  jobWindows++;
  return () => {
    jobWindows--;
  };
}

/**
 * After a resume: brings back a window that shows the job, as Etch's Make
 * panel and Volt's mill window come back. An export dialog with the job in it
 * stays as it is; with none open, Machine Setup opens, which carries the
 * progress and the overrides whatever started the job (MCP included).
 */
export function showJobWindow(): void {
  if (jobWindows === 0) useStore.getState().setMachineConfigOpen(true);
}
