import Link from 'next/link'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card.tsx'
import { caseHref, PREVIEW_SURFACES } from './catalog.ts'

/**
 * The index of the design review.
 *
 * Its job is to make the states reachable, because a state nobody can find is a state nobody
 * reviews. Every entry links to a concrete URL rather than describing one, and each carries
 * the reason it is on the list — an empty state is worth a look precisely when the reviewer
 * knows what it is standing in for.
 *
 * Rendered from `catalog.ts` rather than hand-written so it cannot drift from the routes: the
 * isolation test walks the same list (`specs/UC-10-ux-preview.md` §5).
 */
export default function PreviewIndexPage(): React.ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl">Revisión de diseño</h1>
        <p className="text-sm text-muted-foreground">
          Las siete pantallas del panel, cada una en los estados que vale la pena discutir. Los
          números son inventados: lo que se revisa aquí es tipografía, contraste, espaciado,
          foco y jerarquía — no el contenido.
        </p>
      </header>

      <ul className="flex flex-col gap-4">
        {PREVIEW_SURFACES.map((surface) => (
          <li key={surface.path}>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{surface.title}</CardTitle>
                <CardDescription>{surface.summary}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 border-t border-border pt-4">
                {surface.cases.map((entry) => (
                  <Link
                    key={entry.caso ?? 'default'}
                    href={caseHref(surface, entry)}
                    // Not a chip: a whole row is the target, so the 44px minimum is met by
                    // the padding rather than by a height nobody would otherwise need
                    // (DashOne §2).
                    className="flex flex-col gap-0.5 rounded-sm px-3 py-2.5 transition-colors duration-fast ease-brew hover:bg-muted"
                  >
                    <span className="text-sm font-medium text-foreground">{entry.label}</span>
                    <span className="text-xs text-muted-foreground">{entry.note}</span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  )
}
