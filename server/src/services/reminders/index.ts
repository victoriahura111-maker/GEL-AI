export {
  createReminder,
  listRemindersForTask,
  listRemindersForUser,
  getReminderById,
  updateReminder,
  cancelReminder,
  listDueReminders,
  claimReminder,
  markReminderSent,
  markReminderFailed,
  rescheduleReminder,
  ReminderRepositoryError,
} from './repository';
export type {
  ReminderRecord,
  ReminderStatus,
  CreateReminderRecordInput,
  UpdateReminderPatch,
  ListRemindersForUserFilters,
} from './repository';

// Phase 13 — pure schedule computation + offset/date-time parsing.
export {
  computeScheduledFor,
  parseOffset,
  parseDateTime,
  convertLocalToUtc,
  resolveDeadlineInstant,
  advanceRecurrence,
  ReminderScheduleError,
  END_OF_DAY_TIME,
} from './schedule';
export type {
  ReminderMode,
  TaskDeadline,
  ComputeScheduledForInput,
  ComputedSchedule,
  ReminderScheduleErrorCode,
} from './schedule';

// Phase 13 — reminder engine (tick core + scheduler lifecycle).
export {
  processDueReminders,
  buildReminderNotification,
  startReminderScheduler,
  stopReminderScheduler,
  isReminderSchedulerRunning,
  DEFAULT_TICK_LIMIT,
} from './engine';
export type { ReminderTickResult } from './engine';
