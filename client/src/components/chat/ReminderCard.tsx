import { Bell, Clock } from 'lucide-react';
import { Button } from '../Button';
import type { ReminderAction, ReminderCard as ReminderCardData } from '../../types/assistant';

interface ReminderCardProps {
  card: ReminderCardData;
  onAction?: (action: ReminderAction) => void;
}

export function ReminderCard({ card, onAction }: ReminderCardProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3.5 shadow-soft">
      <p className="text-sm font-semibold text-gray-900">{card.title}</p>
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {card.time}
      </p>
      {card.description ? <p className="mt-1 text-xs text-gray-500">{card.description}</p> : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {card.actions.includes('set') ? (
          <Button size="sm" onClick={() => onAction?.('set')}>
            <Bell className="h-3.5 w-3.5" aria-hidden="true" />
            Set Reminder
          </Button>
        ) : null}
        {card.actions.includes('cancel') ? (
          <Button size="sm" variant="ghost" onClick={() => onAction?.('cancel')}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}
