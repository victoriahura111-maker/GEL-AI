import { MessageSquare, Trash2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { ChatProvider, useChat } from '../context/ChatContext';
import { ChatMessages } from '../components/chat/ChatMessages';
import { MessageInput } from '../components/chat/MessageInput';
import type {
  AssistantActionRequest,
  AssistantCard,
  FollowUpActionId,
  TaskUpdateActionName,
} from '../types/assistant';

/**
 * Fallback follow-up phrases for card types that do not yet have a dedicated
 * action endpoint (reminder scheduling is a later phase). The backend
 * re-extracts these as intents.
 */
function buildCardFollowUp(card: AssistantCard, action: string): string | null {
  switch (card.type) {
    case 'reminder':
      if (action === 'set') return 'Yes, set the reminder.';
      if (action === 'cancel') return 'No, cancel that.';
      return null;
    default:
      return null;
  }
}

function AssistantChat() {
  const {
    messages,
    isSending,
    isActing,
    sendMessage,
    runAssistantAction,
    retryLastMessage,
    clearConversation,
  } = useChat();

  /**
   * Confirms a task change for a specific task id by POSTing the matching
   * action. `complete_task`/`cancel_task`/`delete_task` send just the task id;
   * everything else goes through `update_task` with the structured changes.
   */
  const runTaskChange = (
    controller: { action?: TaskUpdateActionName; changes?: Record<string, unknown> },
    taskId: string
  ) => {
    const actionName = controller.action ?? 'update_task';
    const changes = controller.changes ?? {};

    switch (actionName) {
      case 'complete_task':
        void runAssistantAction({ action: 'complete_task', taskId });
        return;
      case 'cancel_task':
        void runAssistantAction({ action: 'cancel_task', taskId });
        return;
      case 'delete_task':
        void runAssistantAction({ action: 'delete_task', taskId });
        return;
      case 'move_task': {
        const databaseId =
          typeof changes.databaseId === 'string' ? changes.databaseId : undefined;
        if (databaseId) {
          const payload: AssistantActionRequest = { action: 'move_task', taskId, databaseId };
          void runAssistantAction(payload);
          return;
        }
        break;
      }
      default:
        break;
    }

    const payload: AssistantActionRequest = { action: 'update_task', taskId, changes };
    void runAssistantAction(payload);
  };

  const handleCardAction = (card: AssistantCard, action: string, value?: string) => {
    // Task preview: Create confirms via the action endpoint; Edit re-enters the
    // chat so the AI re-extracts; Cancel is a benign acknowledgement.
    if (card.type === 'task') {
      if (action === 'create' && card.task) {
        void runAssistantAction({
          action: 'create_task',
          task: card.task,
          reminder: card.reminder,
          databaseId: value ?? card.database?.id,
        });
        return;
      }
      if (action === 'cancel') {
        void runAssistantAction({ action: 'cancel' });
        return;
      }
      if (action === 'edit') {
        void sendMessage('Let me change the due date.');
        return;
      }
    }

    // Phase 11 — a proposed task update awaiting explicit confirmation.
    if (card.type === 'task_update') {
      if (action === 'confirm' && card.taskId) {
        runTaskChange(card, card.taskId);
        return;
      }
      if (action === 'cancel') {
        void runAssistantAction({ action: 'cancel' });
        return;
      }
    }

    // Phase 11 — disambiguation: picking a candidate confirms the carried change.
    if (card.type === 'task_select') {
      if (action === 'select' && value) {
        const candidate = card.candidates.find((item) => item.taskId === value);
        if (candidate) {
          runTaskChange(card, candidate.taskId);
        }
        return;
      }
      if (action === 'cancel') {
        void runAssistantAction({ action: 'cancel' });
        return;
      }
    }

    // "Which database?" confirmation: a candidate pick confirms creation.
    if (card.type === 'confirmation') {
      if (action === 'confirm' && card.task) {
        void runAssistantAction({
          action: 'create_task',
          task: card.task,
          reminder: card.reminder,
          databaseId: value,
        });
        return;
      }
      if (action === 'cancel') {
        void runAssistantAction({ action: 'cancel' });
        return;
      }
    }

    // Phase 15 — follow-up card. "Blocked" carries the typed reason; the
    // reschedule actions carry the new deadline; every other button is a
    // direct response.
    if (card.type === 'follow_up') {
      if (action === 'blocked' && value) {
        void runAssistantAction({ action: 'follow_up_reason', taskId: card.taskId, reason: value });
        return;
      }
      if ((action === 'need_more_time' || action === 'move_deadline') && value) {
        void runAssistantAction({
          action: 'follow_up_new_deadline',
          taskId: card.taskId,
          deadline: value,
        });
        return;
      }
      void runAssistantAction({
        action: 'follow_up_response',
        taskId: card.taskId,
        response: action as FollowUpActionId,
      });
      return;
    }

    const followUp = buildCardFollowUp(card, action);
    if (followUp) {
      void sendMessage(followUp);
    }
  };

  return (
    <section className="flex h-full flex-col">
      <PageHeader
        title="Assistant"
        description="Your AI copilot for planning, organizing, and acting on tasks."
        actions={
          messages.length > 0 ? (
            <Button variant="secondary" size="sm" onClick={clearConversation}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Clear conversation
            </Button>
          ) : undefined
        }
      />

      <Card className="flex h-[calc(100vh-18rem)] min-h-[24rem] flex-col overflow-hidden md:h-[calc(100vh-13rem)]">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-600">
              <MessageSquare className="h-7 w-7" aria-hidden="true" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-gray-900">Start a conversation</h3>
            <p className="mt-1 max-w-md text-sm text-gray-500">
              Ask your assistant to plan a day, create tasks, or set reminders.
            </p>
          </div>
        ) : (
          <ChatMessages
            messages={messages}
            isSending={isSending}
            isActing={isActing}
            onRetry={() => void retryLastMessage()}
            onCardAction={handleCardAction}
          />
        )}

        <div className="border-t border-gray-100 p-4">
          <MessageInput
            onSend={(content) => void sendMessage(content)}
            disabled={isSending || isActing}
          />
        </div>
      </Card>
    </section>
  );
}

export function AssistantPage() {
  return (
    <ChatProvider>
      <AssistantChat />
    </ChatProvider>
  );
}
