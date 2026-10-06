import { useEffect, useRef } from 'react';
import type { AssistantCard, AssistantMessage } from '../../types/assistant';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';

interface ChatMessagesProps {
  messages: AssistantMessage[];
  isSending: boolean;
  /** Disables card actions while an action is in flight. */
  isActing?: boolean;
  onRetry?: (message: AssistantMessage) => void;
  onCardAction?: (card: AssistantCard, action: string, databaseId?: string) => void;
}

export function ChatMessages({
  messages,
  isSending,
  isActing,
  onRetry,
  onCardAction,
}: ChatMessagesProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Optional call: jsdom does not implement scrollIntoView.
    endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages, isSending]);

  return (
    <div role="log" aria-label="Chat messages" className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          disabled={isActing}
          onRetry={onRetry ? () => onRetry(message) : undefined}
          onCardAction={onCardAction}
        />
      ))}
      {isSending ? <TypingIndicator /> : null}
      <div ref={endRef} />
    </div>
  );
}
