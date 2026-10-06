import { LayoutDashboard, MessageSquare, CheckSquare, Bell, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/assistant', label: 'Assistant', icon: MessageSquare },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/reminders', label: 'Reminders', icon: Bell },
  { to: '/settings', label: 'Settings', icon: Settings },
];
