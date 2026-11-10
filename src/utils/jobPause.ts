import { createJobPauseVisibility } from '@physbox-io/ui';

/**
 * Whether the operator has put the job-pause or tool-change dialog aside, for
 * one stop: the next stop is a new instruction and opens by itself. The same
 * store Etch and Volt use; a stop's key is `jobStopKey(status, line, message)`,
 * with line 0 for a feed hold, whose line can still tick over as the planner drains.
 */
export const jobPause = createJobPauseVisibility();
