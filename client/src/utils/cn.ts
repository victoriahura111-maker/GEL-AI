export type ClassValue = string | false | null | undefined;

/**
 * Joins class names together, filtering out falsy values.
 * Kept dependency-free so the design system stays lightweight.
 */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ');
}
