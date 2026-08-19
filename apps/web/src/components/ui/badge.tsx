import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '../../lib/utils.ts'

/**
 * Daily Brew badge.
 *
 * The `warning` and `danger` variants carry meaning the layout does not: a gapped panel and
 * a failed crawl are both "this number is weaker than it looks". They pair a tinted
 * background with a readable foreground rather than relying on hue alone, so the distinction
 * survives a colour-blind reader — colour is never the only channel.
 */

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-medium',
  {
    variants: {
      variant: {
        neutral: 'bg-muted text-muted-foreground',
        primary: 'bg-primary/15 text-primary',
        // Amber at AA against the card surface.
        warning: 'bg-amber-500/15 text-amber-300',
        danger: 'bg-red-500/15 text-red-300',
        success: 'bg-emerald-500/15 text-emerald-300',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): React.ReactElement {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { badgeVariants }
