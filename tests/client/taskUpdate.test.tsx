import { render, screen, fireEvent } from '@testing-library/react';
import { AssistantPage } from '../../client/src/pages/AssistantPage';
import { postAssistantAction, sendAssistantMessage } from '../../client/src/services/assistant';
import type { AssistantCard, AssistantMessage } from '../../client/src/types/assistant';

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

function typeAndSend(content: string) {
  fireEvent.change(screen.getByPlaceholderText(/message your assistant/i), {
    target: { value: content },
  });
  fireEvent.click(screen.getByRole('button', { name: /send message/i }));
}

function assistantMessageWithCard(card: AssistantCard): AssistantMessage {
  return {
    id: 'msg-assistant-1',
    role: 'assistant',
    content: 'Here is what I found.',
    createdAt: '2026-10-03T12:00:00.000Z',
    status: 'sent',
    cards: [card],
  };
}

const actionResult = (content: string): unknown => ({
  message: {
    id: 'msg-confirm',
    role: 'assistant',
    content,
    createdAt: '2026-10-03T12:00:01.000Z',
    status: 'sent',
  },
  conversationId: 'conv-1',
  needsDatabase: false,
  candidates: [],
  notionUrl: null,
  warnings: [],
});

describe('task update UI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a task_update card and posts update_task on Confirm', async () => {
    mockSendAssistantMessage.mockResolvedValue({
      message: assistantMessageWithCard({
        type: 'task_update',
        change: 'Update: set priority to high',
        targetTask: 'Write report',
        taskId: 'task-1',
        changes: { priority: 'high' },
        action: 'update_task',
        actions: ['confirm', 'cancel'],
      }),
      conversationId: 'conv-1',
    });
    mockPostAssistantAction.mockResolvedValue(actionResult("Done. I've updated Write report."));

    render(<AssistantPage />);
    typeAndSend('Change the priority to high.');

    expect(await screen.findByText(/set priority to high/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(mockPostAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update_task',
        taskId: 'task-1',
        changes: { priority: 'high' },
      })
    );
    expect(await screen.findByText(/Done. I've updated/i)).toBeInTheDocument();
  });

  it('posts complete_task when the card proposes completion', async () => {
    mockSendAssistantMessage.mockResolvedValue({
      message: assistantMessageWithCard({
        type: 'task_update',
        change: 'Mark as completed',
        targetTask: 'Write report',
        taskId: 'task-1',
        changes: { status: 'completed' },
        action: 'complete_task',
        actions: ['confirm', 'cancel'],
      }),
      conversationId: 'conv-1',
    });
    mockPostAssistantAction.mockResolvedValue(actionResult("Done. I've marked it completed."));

    render(<AssistantPage />);
    typeAndSend('Mark it completed.');

    fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));

    expect(mockPostAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'complete_task', taskId: 'task-1' })
    );
  });

  it('renders a task_select card and posts the change for the chosen candidate', async () => {
    mockSendAssistantMessage.mockResolvedValue({
      message: assistantMessageWithCard({
        type: 'task_select',
        prompt: 'I found 2 tasks that match. Which one do you mean?',
        candidates: [
          { taskId: 't-a', title: 'Report alpha', dueDate: '2026-10-05' },
          { taskId: 't-b', title: 'Report beta', database: 'Work' },
        ],
        action: 'update_task',
        changes: { dueDate: '2026-10-06' },
        actions: ['cancel'],
      }),
      conversationId: 'conv-1',
    });
    mockPostAssistantAction.mockResolvedValue(actionResult("Done. I've updated it."));

    render(<AssistantPage />);
    typeAndSend('Move the report to Monday.');

    expect(await screen.findByText('Report alpha')).toBeInTheDocument();
    expect(screen.getByText('Report beta')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /report alpha/i }));

    expect(mockPostAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update_task',
        taskId: 't-a',
        changes: { dueDate: '2026-10-06' },
      })
    );
  });
});
