export {
  listOpenTasksForFollowUp,
  updateFollowUpFields,
  clearAwaitingFollowUp,
  FollowUpRepositoryError,
  OPEN_TASK_STATUSES,
} from './repository';
export type { FollowUpFieldsPatch } from './repository';

// Phase 15 — pure candidate selection + async loader.
export {
  selectFollowUpCandidates,
  evaluateFollowUpCandidates,
  defaultFollowUpOptions,
} from './candidates';
export type { FollowUpCandidate, FollowUpCandidateOptions } from './candidates';

// Phase 15 — engine (tick core) + card/notification builders.
export {
  processFollowUps,
  buildFollowUpCard,
  buildFollowUpNotification,
  describeDueSoon,
  describeOverdue,
  DEFAULT_FOLLOW_UP_TICK_LIMIT,
  FOLLOW_UP_CHANNELS,
} from './engine';
export type { FollowUpTickResult } from './engine';

// Phase 15 — scheduler lifecycle.
export {
  startFollowUpScheduler,
  stopFollowUpScheduler,
  isFollowUpSchedulerRunning,
} from './scheduler';

// Phase 15 — response handling.
export { handleFollowUpResponse, detectFollowUpExpectation } from './respond';
export type {
  FollowUpResponseVerb,
  HandleFollowUpResponseInput,
  HandleFollowUpResponseResult,
  FollowUpExpectation,
} from './respond';
