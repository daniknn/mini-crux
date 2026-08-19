import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '../../lib/utils.ts'

/**
 * Daily Brew button (DashOne §2).
 *
 * `h-11` is 44px, the minimum touch target, and it is on the default size rather than on an
 * opt-in one so that hitting the requirement is the path of least resistance. The press
 * scale is a plain `active:` utility because `globals.css` disables exactly that class under
 * `prefers-reduced-motion`; an inline transform would escape that switch.
 */

const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 rounded-sm font-medium',
    'transition-colors duration-fast ease-brew active:scale-[0.97]',
    'disabled:pointer-events-none disabled:opacity-50',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-muted text-foreground hover:bg-muted/80',
        outline: 'border border-border bg-transparent text-foreground hover:bg-muted',
        ghost: 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
      },
      size: {
        // Both are 44px. There is deliberately no smaller size: a "compact" variant is how
        // the touch-target minimum gets lost, one reasonable-looking exception at a time.
        // Smaller *text* is fine and is what `text-xs` on the caller is for.
        default: 'h-11 px-5 text-sm',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...props },
  ref,
) {
  return (
    // Default `type="button"`: an unset type inside a form is `submit`, so a stray "cancel"
    // would post the form.
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
})

export { buttonVariants }
