-- TaskStatus: add 'paused' for the pause feature (task-pause.ts). A running
-- task the user pauses flips to this value; the executor loop exits cleanly
-- and resume replays the kept workdir. The value was referenced in code but
-- missing from the enum, which broke `tsc` (comparison with no overlap).
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'paused';
