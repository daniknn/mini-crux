'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '../lib/utils.ts'

/**
 * The six dashboard surfaces, in the order the panel produces them.
 *
 * `Análisis` sits after `Estructura` because that is the dependency: structure describes how
 * one advertiser builds creatives, and analysis is the only surface that relates any of it to
 * survival. Putting the conclusion ahead of the description invites reading the finding
 * without the panel it rests on.
 *
 * `Validación` sits after `Análisis` for the same reason one level up: it is UC-7's report on
 * whether *días activos*, the input to every contrast on the analysis page, tracks anything
 * real — a reader who has not yet seen what the proxy is used for has no context for what
 * validating it means. It is a separate corpus (Spain, quarantined from the MX panel) and its
 * own page rather than a section of `Análisis`, because its verdict answers a different
 * question and must never be read as changing the MX numbers on the page before it.
 *
 * No workspace appears in any href. The tenant is the active Clerk Organization, read from
 * the session — a route like `/w/:slug/creativos` would let a signed-in user of workspace A
 * type workspace B's slug, and while RLS would still deny the rows, the app would be asking
 * a question it has no business asking.
 */
const LINKS = [
  { href: '/novedades', label: 'Novedades' },
  { href: '/creativos', label: 'Creativos' },
  { href: '/estructura', label: 'Estructura' },
  { href: '/analisis', label: 'Análisis' },
  { href: '/validacion-proxy', label: 'Validación' },
  { href: '/listas', label: 'Listas' },
] as const

/**
 * `basePath` exists for the `/ux` preview and nothing else (UC-10). It is the same nav, the
 * same markup and the same classes — pointed at the fixture routes so that clicking through
 * the design review does not land on a surface that needs a database. The dashboard passes
 * nothing and gets exactly what it had.
 */
export function Nav({ basePath = '' }: { basePath?: string }): React.ReactElement {
  const pathname = usePathname()

  return (
    <nav aria-label="Secciones" className="flex items-center gap-1">
      {LINKS.map((link) => {
        const href = `${basePath}${link.href}`
        // Prefix match so `/creativos/abc123` keeps "Creativos" lit.
        const active = pathname === href || pathname.startsWith(`${href}/`)
        return (
          <Link
            key={link.href}
            href={href}
            // Communicated to assistive tech as well as visually — the colour change alone
            // says nothing to a screen reader.
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-11 items-center rounded-sm px-4 text-sm transition-colors duration-fast ease-brew',
              active
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}
