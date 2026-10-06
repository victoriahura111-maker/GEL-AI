import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createUserMessage, postAssistantAction, sendAssistantMessage } from '../services/assistant';
import type { AssistantActionRequest, AssistantMessage } from '../types/assistant';

interface ChatContextValue {
  messages: AssistantMessage[];
  isSending: boolean;
  /** True while a card action (create/cancel) is in flight. */
  isActing: boolean;
  error: string | null;
  conversationId: string | null;
  sendMessage: (content: string) => Promise<void>;
  /** Runs an explicit card action (create_task / cancel) and appends the reply. */
  runAssistantAction: (payload: AssistantActionRequest) => Promise<void>;
  retryLastMessage: () => void;
  clearConversation: () => void;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

/**
 * Holds the in-memory chat session. The `conversationId` starts as `null` and
 * is replaced with the id the server returns after the first successful send;
 * it is then echoed back on every subsequent turn so the server appends to the
 * same thread. Loading history across reloads is a later phase (Phase 20).
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isActing, setIsActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const actingRef = useRef(false);
  const lastUserMessageIdRef = useRef<string | null>(null);
  const lastContentRef = useRef<string | null>(null);

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || sendingRef.current) return;

      sendingRef.current = true;

      const userMessage = createUserMessage(trimmed);
      lastContentRef.current = trimmed;
      lastUserMessageIdRef.current = userMessage.id;
      // Capture prior turns before appending the optimistic user message so the
      // backend receives conversational context (newest last).
      const history = messages;

      setError(null);
      setIsSending(true);
      setMessages((prev) => [...prev, userMessage]);

      try {
        const { message: assistantMessage, conversationId: nextConversationId } =
          await sendAssistantMessage(conversationId, trimmed, history);

        // Adopt the server-owned conversation id for the next turn. A `null`
        // result (persistence disabled) leaves the current value untouched.
        if (nextConversationId && nextConversationId !== conversationId) {
          setConversationId(nextConversationId);
        }

        setMessages((prev) => {
          const withSentUserMessage = prev.map((message) =>
            message.id === userMessage.id ? { ...message, status: 'sent' as const } : message
          );
          return [...withSentUserMessage, assistantMessage];
        });
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Something went wrong. Please try again.';
        setError(message);
        setMessages((prev) =>
          prev.map((item) =>
            item.id === userMessage.id ? { ...item, status: 'error' as const } : item
          )
        );
      } finally {
        sendingRef.current = false;
        setIsSending(false);
      }
    },
    [conversationId, messages]
  );

  const runAssistantAction = useCallback(
    async (payload: AssistantActionRequest) => {
      if (actingRef.current) return;

      actingRef.current = true;
      setError(null);
      setIsActing(true);

      try {
        const result = await postAssistantAction({
          ...payload,
          conversationId: conversationId ?? undefined,
        });

        if (result.conversationId && result.conversationId !== conversationId) {
          setConversationId(result.conversationId);
        }

        setMessages((prev) => [...prev, result.message]);
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Something went wrong. Please try again.';
        setError(message);
      } finally {
        actingRef.current = false;
        setIsActing(false);
      }
    },
    [conversationId]
  );

  const retryLastMessage = useCallback(() => {
    const content = lastContentRef.current;
    const failedId = lastUserMessageIdRef.current;
    if (!content || sendingRef.current) return;

    setError(null);
    if (failedId) {
      setMessages((prev) => prev.filter((message) => message.id !== failedId));
      lastUserMessageIdRef.current = null;
    }
    lastContentRef.current = null;

    void sendMessage(content);
  }, [sendMessage]);

  const clearConversation = useCallback(() => {
    if (sendingRef.current) return;
    setMessages([]);
    setError(null);
    // A cleared chat starts a fresh thread on the next send.
    setConversationId(null);
    lastUserMessageIdRef.current = null;
    lastContentRef.current = null;
  }, []);

  const value = useMemo(
    () => ({
      messages,
      isSending,
      isActing,
      error,
      conversationId,
      sendMessage,
      runAssistantAction,
      retryLastMessage,
      clearConversation,
    }),
    [
      messages,
      isSending,
      isActing,
      error,
      conversationId,
      sendMessage,
      runAssistantAction,
      retryLastMessage,
      clearConversation,
    ]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
}
