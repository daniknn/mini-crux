import * as React from 'react'

import { cn } from '../../lib/utils.ts'

/**
 * Daily Brew input. `h-11` is the 44px touch target; the focus ring comes from the global
 * `:focus-visible` box-shadow rather than a per-component outline, so it cannot drift.
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-11 w-full rounded-sm border border-input bg-muted px-3 text-sm text-foreground',
          'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    )
  },
)

/**
 * A label is not decoration: an input without one is unusable with a screen reader, so the
 * pairing is a component rather than a convention someone has to remember.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
