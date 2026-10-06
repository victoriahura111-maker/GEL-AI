import { User, Bot, BellRing, Clock, Link2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '../components/Card';

interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string;
  isRoute?: boolean;
}

const SECTIONS: SettingsSection[] = [
  { id: 'account', label: 'Account', icon: User, href: '#account' },
  { id: 'assistant', label: 'Assistant', icon: Bot, href: '#assistant' },
  { id: 'notifications', label: 'Notifications', icon: BellRing, href: '#notifications' },
  { id: 'reminders', label: 'Reminders', icon: Clock, href: '#reminders' },
  { id: 'notion', label: 'Notion', icon: Link2, href: '/settings/notion', isRoute: true },
];

export function SettingsPage() {
  return (
    <section>
      <PageHeader
        title="Settings"
        description="Manage your account, assistant preferences, and integrations."
      />

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <nav
          aria-label="Settings sections"
          className="flex gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-white p-2 shadow-card md:block md:space-y-1 md:overflow-visible"
        >
          {SECTIONS.map((section) => {
            const linkClass =
              'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900';
            return section.isRoute ? (
              <Link key={section.id} to={section.href} className={linkClass}>
                <section.icon className="h-4 w-4" aria-hidden="true" />
                {section.label}
              </Link>
            ) : (
              <a key={section.id} href={section.href} className={linkClass}>
                <section.icon className="h-4 w-4" aria-hidden="true" />
                {section.label}
              </a>
            );
          })}
        </nav>

        <Card id="account">
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>
              Profile, sign-in, and account-level preferences.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-500">
              Individual settings panels arrive in later phases. Use the section navigation to
              explore the layout.
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
