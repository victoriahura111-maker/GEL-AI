import { useLocation } from 'react-router-dom';
import { LogOut, Sparkles } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { NAV_ITEMS } from './navigation';
import { NotificationBell } from './notifications/NotificationBell';

const APP_NAME = 'AI Virtual Task Assistant';

function getPageTitle(pathname: string): string {
  if (pathname.startsWith('/settings/notion')) return 'Notion';
  const sorted = [...NAV_ITEMS].sort((a, b) => b.to.length - a.to.length);
  const match = sorted.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  return match ? match.label : 'Dashboard';
}

export function TopBar() {
  const { user, profile, signOut } = useAuth();
  const location = useLocation();
  const title = getPageTitle(location.pathname);

  const fullName = profile?.full_name?.trim();
  const initials = fullName
    ? fullName
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join('')
    : (user?.email?.charAt(0).toUpperCase() ?? 'U');

  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between border-b border-gray-200 bg-white/80 px-4 backdrop-blur md:px-8">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white md:hidden">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        </span>
        <h1 className="truncate text-base font-semibold text-gray-900 md:text-lg">
          <span className="md:hidden">{APP_NAME}</span>
          <span className="hidden md:inline">{title}</span>
        </h1>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <NotificationBell />
        <div className="hidden items-center gap-3 md:flex">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
            {initials}
          </div>
          <div className="hidden text-right lg:block">
            <p className="text-sm font-medium leading-tight text-gray-900">
              {profile?.full_name ?? 'Account'}
            </p>
            <p className="text-xs text-gray-500">{user?.email ?? ''}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void signOut()}
          aria-label="Sign out"
          className="flex items-center gap-2 rounded-md p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 md:hidden"
        >
          <LogOut className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
