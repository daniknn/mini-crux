import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge Tailwind classes so a caller's override actually wins.
 *
 * Plain concatenation leaves both `p-4` and `p-6` on the element and the winner is whichever
 * Tailwind emitted last — a source-order coincidence, not a decision. `twMerge` drops the
 * losing class outright, which is what makes the `className` prop on a base component
 * dependable enough that nobody needs to fork one.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
