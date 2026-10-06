import { useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import { Button } from '../Button';

interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export function MessageInput({ onSend, disabled = false }: MessageInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoGrow = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;
    if (scrollHeight > 0) {
      textarea.style.height = `${Math.min(scrollHeight, 160)}px`;
    }
  };

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
    const textarea = textareaRef.current;
    if (textarea) textarea.style.height = 'auto';
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          autoGrow();
        }}
        onKeyDown={handleKeyDown}
        rows={1}
        aria-label="Message"
        placeholder="Message your assistant…"
        disabled={disabled}
        className="max-h-40 flex-1 resize-none rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500"
      />
      <Button
        type="submit"
        disabled={disabled || value.trim() === ''}
        aria-label="Send message"
        className="shrink-0 px-3"
      >
        <Send className="h-4 w-4" aria-hidden="true" />
      </Button>
    </form>
  );
}
