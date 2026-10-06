import { render, screen, fireEvent } from '@testing-library/react';
import { AssistantPage } from '../../client/src/pages/AssistantPage';
import { postAssistantAction, sendAssistantMessage } from '../../client/src/services/assistant';
import type { AssistantMessage, FollowUpCard } from '../../client/src/types/assistant';

/**
 * Phase 15 — follow-up card UI. The assistant service is mocked; the card must
 * render the correct buttons per kind and post the right action payloads.
 */

jest.mock('../../client/src/services/assistant', () => ({
  sendAssistantMessage: jest.fn(),
  postAssistantAction: jest.fn(),
  createUserMessage: (content: string) => ({
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user' as const,
    content,
    createdAt: new Date().toISOString(),
    status: 'sent' as const,
  }),
  makeId: () => `msg-${Math.random().toString(36).slice(2, 10)}`,
}));

const mockSendAssistantMessage = sendAssistantMessage as jest.Mock;
const mockPostAssistantAction = postAssistantAction as jest.Mock;

const DUE_SOON_CARD: FollowUpCard = {
  type: 'follow_up',
  kind: 'due_soon',
  taskId: 'task-1',
  taskTitle: 'Write report',
  dueLabel: 'tomorrow',
  prompt: 'Your "Write report" is due tomorrow. How is it going?',
  actions: ['completed', 'in_progress', 'blocked', 'need_more_time'],
};

const OVERDUE_CARD: FollowUpCard = {
  type: 'follow_up',
  kind: 'overdue',
  taskId: 'task-1',
  taskTitle: 'Write report',
  dueLabel: 'yesterday',
  prompt: 'Your "Write report" was due yesterday. Would you like to:',
  actions: ['mark_completed', 'continue_working', 'move_deadline'],
};

function typeAndSend(content: string) {
  fireEvent.change(screen.getByPlaceholderText(/message your assistant/i), {
    target: { value: content },
  });
  fireEvent.click(screen.getByRole('button', { name: /send message/i }));
}

async function renderWithCard(card: FollowUpCard): Promise<void> {
  const message: AssistantMessage = {
    id: 'msg-assistant-followup',
    role: 'assistant',
    content: card.prompt,
    createdAt: '2026-10-06T09:00:00.000Z',
    status: 'sent',
    cards: [card],
  };
  mockSendAssistantMessage.mockResolvedValue({ message, conversationId: 'conv-1' });

  render(<AssistantPage />);
  typeAndSend('anything');
  // The prompt appears twice — on the message bubble and inside the card — so
  // wait for all matches rather than a single one.
  await screen.findAllByText(card.prompt);
}

describe('follow-up card UI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPostAssistantAction.mockResolvedValue({
      message: {
        id: 'msg-action',
        role: 'assistant',
        content: 'Got it.',
        createdAt: '2026-10-06T09:01:00.000Z',
        status: 'sent',
      },
      conversationId: 'conv-1',
      needsDatabase: false,
      candidates: [],
      notionUrl: null,
      warnings: [],
    });
  });

  it('renders the due_soon button set', async () => {
    await renderWithCard(DUE_SOON_CARD);

    expect(screen.getByRole('button', { name: /completed/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /in progress/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /blocked/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /need more time/i })).toBeInTheDocument();
  });

  it('renders the overdue button set', async () => {
    await renderWithCard(OVERDUE_CARD);

    expect(screen.getByRole('button', { name: /mark completed/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue working/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /move deadline/i })).toBeInTheDocument();
  });

  it('posts a direct follow_up_response for a simple button', async () => {
    await renderWithCard(DUE_SOON_CARD);

    fireEvent.click(screen.getByRole('button', { name: /in progress/i }));

    expect(mockPostAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'follow_up_response',
        taskId: 'task-1',
        response: 'in_progress',
      })
    );
  });

  it('reveals the reason input and posts follow_up_reason', async () => {
    await renderWithCard(DUE_SOON_CARD);

    fireEvent.click(screen.getByRole('button', { name: /blocked/i }));

    const textarea = screen.getByLabelText(/blocking reason/i);
    fireEvent.change(textarea, { target: { value: 'waiting on review' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(mockPostAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'follow_up_reason',
        taskId: 'task-1',
        reason: 'waiting on review',
      })
    );
  });

  it('reveals the deadline input and posts follow_up_new_deadline', async () => {
    await renderWithCard(OVERDUE_CARD);

    fireEvent.click(screen.getByRole('button', { name: /move deadline/i }));

    const input = screen.getByLabelText(/new deadline/i);
    fireEvent.change(input, { target: { value: '2026-10-20T17:00' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(mockPostAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'follow_up_new_deadline',
        taskId: 'task-1',
        deadline: '2026-10-20T17:00',
      })
    );
  });

  it('posts follow_up_response for the overdue mark_completed button', async () => {
    await renderWithCard(OVERDUE_CARD);

    fireEvent.click(screen.getByRole('button', { name: /mark completed/i }));

    expect(mockPostAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'follow_up_response',
        taskId: 'task-1',
        response: 'mark_completed',
      })
    );
  });
});
