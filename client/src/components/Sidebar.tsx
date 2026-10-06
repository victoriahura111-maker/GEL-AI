import { NavLink } from 'react-router-dom';
import { LogOut, Sparkles } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { NAV_ITEMS } from './navigation';
import { cn } from '../utils/cn';

const APP_NAME = 'AI Virtual Task Assistant';

export function Sidebar() {
  const { user, signOut } = useAuth();

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-gray-200 bg-white md:flex">
      <div className="flex h-16 items-center gap-2.5 border-b border-gray-200 px-5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight text-gray-900">{APP_NAME}</p>
          <p className="text-xs text-gray-500">Productivity shell</p>
        </div>
      </div>

      <nav
        aria-label="Sidebar navigation"
        className="flex-1 space-y-1 overflow-y-auto px-3 py-4"
      >
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              )
            }
          >
            <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="truncate">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-gray-200 p-4">
        <div className="mb-3 min-w-0">
          <p className="truncate text-sm font-medium text-gray-900">{user?.email ?? 'Signed in'}</p>
          <p className="text-xs text-gray-500">Account</p>
        </div>
        <button
          type="button"
          onClick={() => void signOut()}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
