import type { AssistantCard } from '../../types/assistant';
import { ConfirmationCard } from './ConfirmationCard';
import { FollowUpCard } from './FollowUpCard';
import { ReminderCard } from './ReminderCard';
import { TaskCard } from './TaskCard';
import { TaskSelectCard } from './TaskSelectCard';
import { TaskUpdateCard } from './TaskUpdateCard';

interface CardRendererProps {
  card: AssistantCard;
  /** Disables card action buttons while an action is in flight. */
  disabled?: boolean;
  /**
   * `value` carries context for the action: a candidate `databaseId` (task /
   * confirmation cards) or a candidate `taskId` (task_select).
   */
  onAction?: (card: AssistantCard, action: string, value?: string) => void;
}

export function CardRenderer({ card, disabled, onAction }: CardRendererProps) {
  switch (card.type) {
    case 'task':
      return (
        <TaskCard
          card={card}
          disabled={disabled}
          onAction={(action) => onAction?.(card, action)}
        />
      );
    case 'reminder':
      return <ReminderCard card={card} onAction={(action) => onAction?.(card, action)} />;
    case 'task_update':
      return (
        <TaskUpdateCard
          card={card}
          disabled={disabled}
          onAction={(action) => onAction?.(card, action)}
        />
      );
    case 'task_select':
      return (
        <TaskSelectCard
          card={card}
          disabled={disabled}
          onSelect={(candidate) => onAction?.(card, 'select', candidate.taskId)}
          onCancel={() => onAction?.(card, 'cancel')}
        />
      );
    case 'confirmation':
      return (
        <ConfirmationCard
          card={card}
          disabled={disabled}
          onAction={(action, databaseId) => onAction?.(card, action, databaseId)}
        />
      );
    case 'follow_up':
      return (
        <FollowUpCard
          card={card}
          disabled={disabled}
          onAction={(action, value) => onAction?.(card, action, value)}
        />
      );
    default:
      return null;
  }
}
