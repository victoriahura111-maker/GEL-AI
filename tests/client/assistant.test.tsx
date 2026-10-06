import { render, screen, fireEvent } from '@testing-library/react';
import { AssistantPage } from '../../client/src/pages/AssistantPage';
import { postAssistantAction, sendAssistantMessage } from '../../client/src/services/assistant';
import type { AssistantMessage } from '../../client/src/types/assistant';

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

describe('assistant chat UI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the empty state when there are no messages', () => {
    render(<AssistantPage />);

    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/message your assistant/i)).toBeInTheDocument();
  });

  it('appends a user bubble and shows the typing indicator while the service is pending', async () => {
    mockSendAssistantMessage.mockImplementation(() => new Promise(() => undefined));

    render(<AssistantPage />);
    typeAndSend('Plan my day');

    expect(await screen.findByText('Plan my day')).toBeInTheDocument();
    expect(screen.getByLabelText(/assistant is typing/i)).toBeInTheDocument();
  });

  it('renders a resolved assistant message with a task card and its buttons', async () => {
    const assistantMessage: AssistantMessage = {
      id: 'msg-assistant-1',
      role: 'assistant',
      content: 'Here is a task for you:',
      createdAt: '2026-09-24T12:00:00.000Z',
      status: 'sent',
      cards: [
        {
          type: 'task',
          title: 'Write report',
          due: 'Today, 5:00 PM',
          priority: 'high',
          database: { id: 'db-1', title: 'Work Tasks' },
          actions: ['create', 'edit', 'cancel'],
        },
      ],
    };
    mockSendAssistantMessage.mockResolvedValue({
      message: assistantMessage,
      conversationId: 'conv-server-1',
    });

    render(<AssistantPage />);
    typeAndSend('Create a task for my report');

    expect(await screen.findByText('Write report')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create task/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
  });

  it('shows an error state with a Retry action when the service rejects', async () => {
    mockSendAssistantMessage.mockRejectedValue(new Error('network failure'));

    render(<AssistantPage />);
    typeAndSend('Plan my day');

    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByText('Could not send message')).toBeInTheDocument();
  });

  it('disables the input while sending', () => {
    mockSendAssistantMessage.mockImplementation(() => new Promise(() => undefined));

    render(<AssistantPage />);
    typeAndSend('Hello assistant');

    expect(screen.getByPlaceholderText(/message your assistant/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
  });

  it('confirms a task via the action endpoint and renders "View in Notion"', async () => {
    const previewMessage: AssistantMessage = {
      id: 'msg-assistant-preview',
      role: 'assistant',
      content: 'Here is a task for you:',
      createdAt: '2026-09-24T12:00:00.000Z',
      status: 'sent',
      cards: [
        {
          type: 'task',
          title: 'Write report',
          database: { id: 'db-1', title: 'Work Tasks' },
          task: { title: 'Write report', dueDate: '2026-10-03', dueTime: '17:00', priority: 'high' },
          actions: ['create', 'edit', 'cancel'],
        },
      ],
    };
    mockSendAssistantMessage.mockResolvedValue({
      message: previewMessage,
      conversationId: 'conv-1',
    });

    const confirmationMessage: AssistantMessage = {
      id: 'msg-assistant-created',
      role: 'assistant',
      content: '✓ Task created — Write report, Database: Work Tasks',
      createdAt: '2026-09-24T12:00:01.000Z',
      status: 'sent',
      cards: [
        {
          type: 'task',
          title: 'Write report',
          database: { id: 'db-1', title: 'Work Tasks' },
          notionUrl: 'https://www.notion.so/page-1',
          actions: [],
        },
      ],
    };
    mockPostAssistantAction.mockResolvedValue({
      message: confirmationMessage,
      conversationId: 'conv-1',
      needsDatabase: false,
      candidates: [],
      notionUrl: 'https://www.notion.so/page-1',
    });

    render(<AssistantPage />);
    typeAndSend('Create a task for my report');

    expect(await screen.findByRole('button', { name: /create task/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /create task/i }));

    // The card payload (including the resolved databaseId) is POSTed to confirm.
    expect(mockPostAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create_task',
        databaseId: 'db-1',
        task: expect.objectContaining({ title: 'Write report' }),
      })
    );

    expect(await screen.findByText(/Task created/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view in notion/i })).toHaveAttribute(
      'href',
      'https://www.notion.so/page-1'
    );
  });
});
