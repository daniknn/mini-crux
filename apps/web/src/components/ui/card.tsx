import * as React from 'react'

import { cn } from '../../lib/utils.ts'

/** Daily Brew card: `#141414` surface, 16px radius, soft low-opacity shadow. */

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn('rounded-lg border border-border bg-card shadow-soft', className)}
      {...props}
    />
  )
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn('flex flex-col gap-1 p-5', className)} {...props} />
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
  return <h3 className={cn('font-display text-lg text-card-foreground', className)} {...props} />
}

/**
 * The caveat line under a title. Muted, but never optional on a card showing a number:
 * every figure ships with its n and its caveat (rule 8).
 */
export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.ReactElement {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn('p-5 pt-0', className)} {...props} />
}
