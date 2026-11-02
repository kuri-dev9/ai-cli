// 서버가 내려가며 끊긴 일을 다시 뜬 서버가 이어 간다. 서버가 뜰 때와 내려갈 때 한 번씩 부른다.
export {
  abortRunsForShutdown,
  beginShutdown,
  MAX_RESUMES,
  RESUME_PROMPT,
  RESUME_WINDOW_MS,
  resumeInterruptedWork,
} from './services/run-recovery.service.js';
export type { RunRecoveryReport } from './services/run-recovery.service.js';
