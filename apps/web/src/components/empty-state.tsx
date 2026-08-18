import { Card, CardContent, CardDescription, CardTitle } from './ui/card.tsx'

/**
 * What a surface shows when it has nothing.
 *
 * Always says *why* it is empty, because the two reasons are not interchangeable: "the panel
 * is still filling up" and "there is genuinely nothing here" look identical on screen and
 * lead to opposite actions. Longitudinal data cannot be backfilled, so an operator who
 * mistakes the first for the second and stops the crawl loses the window permanently.
 */
export function EmptyState({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-2 p-8">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{children}</CardDescription>
      </CardContent>
    </Card>
  )
}
