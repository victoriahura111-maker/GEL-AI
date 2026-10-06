import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card } from './Card';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <Card className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        <Icon className="h-7 w-7" aria-hidden="true" />
      </div>
      <h3 className="mt-4 text-lg font-semibold text-gray-900">{title}</h3>
      {description ? <p className="mt-1 max-w-md text-sm text-gray-500">{description}</p> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </Card>
  );
}
