import { AlertCircle, RotateCcw } from 'lucide-react';
import type { AssistantCard, AssistantMessage } from '../../types/assistant';
import { CardRenderer } from './CardRenderer';
import { cn } from '../../utils/cn';

interface MessageBubbleProps {
  message: AssistantMessage;
  disabled?: boolean;
  onRetry?: () => void;
  onCardAction?: (card: AssistantCard, action: string, databaseId?: string) => void;
}

export function MessageBubble({ message, disabled, onRetry, onCardAction }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const hasError = message.status === 'error';

  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'flex max-w-[85%] flex-col sm:max-w-[70%]',
          isUser ? 'items-end' : 'items-start'
        )}
      >
        <div
          className={cn(
            'whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm',
            isUser
              ? 'rounded-br-sm bg-brand-600 text-white'
              : 'rounded-bl-sm border border-gray-200 bg-white text-gray-800 shadow-soft'
          )}
        >
          {message.content}
        </div>

        {!isUser && message.cards && message.cards.length > 0 ? (
          <div className="mt-2 flex w-full flex-col gap-2">
            {message.cards.map((card, index) => (
              <CardRenderer
                key={`${message.id}-card-${index}`}
                card={card}
                disabled={disabled}
                onAction={onCardAction}
              />
            ))}
          </div>
        ) : null}

        {hasError ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-red-600">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Could not send message</span>
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1 rounded font-medium underline underline-offset-2 hover:text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
