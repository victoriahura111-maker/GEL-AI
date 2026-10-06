import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from './navigation';
import { cn } from '../utils/cn';

export function MobileNav() {
  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="grid grid-cols-5">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-1 px-1 py-2.5 text-[10px] font-medium transition-colors',
                isActive ? 'text-brand-600' : 'text-gray-500 hover:text-gray-900'
              )
            }
          >
            <item.icon className="h-5 w-5" aria-hidden="true" />
            <span className="truncate">{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
