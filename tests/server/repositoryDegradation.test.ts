// With Supabase unconfigured (`supabaseAdmin === null`) the repositories must
// degrade gracefully instead of throwing, so the server can boot and the
// assistant route can skip persistence safely.
jest.mock('../../server/src/services/supabase', () => ({ supabaseAdmin: null }));

import {
  createTaskRecord,
  deleteTaskRecord,
  findTasksByTitleFragment,
  getTaskById,
  listTasks,
  updateTaskRecord,
} from '../../server/src/services/tasks/repository';
import {
  appendMessage,
  getConversation,
  getOrCreateConversation,
  listConversations,
  listMessages,
} from '../../server/src/services/conversations/repository';

describe('repositories when Supabase is unconfigured', () => {
  it('task repository returns safe defaults without throwing', async () => {
    expect(await createTaskRecord('user-1', { title: 'x' })).toBeNull();
    expect(await getTaskById('user-1', 'task-1')).toBeNull();
    expect(await updateTaskRecord('user-1', 'task-1', { status: 'completed' })).toBeNull();
    expect(await listTasks('user-1')).toEqual([]);
    expect(await deleteTaskRecord('user-1', 'task-1')).toBe(false);
    expect(await findTasksByTitleFragment('user-1', 'x')).toEqual([]);
  });

  it('conversation repository returns safe defaults without throwing', async () => {
    expect(await getOrCreateConversation('user-1')).toBeNull();
    expect(await getConversation('user-1', '11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(await appendMessage('user-1', 'conv-1', { role: 'user', content: 'hi' })).toBeNull();
    expect(await listMessages('user-1', 'conv-1')).toEqual([]);
    expect(await listConversations('user-1')).toEqual([]);
  });
});
