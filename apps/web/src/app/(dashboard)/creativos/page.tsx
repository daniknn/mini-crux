import {
  getPanelHealth,
  listAdvertisers,
  listCreatives,
  type GallerySort,
} from '@mini-crux/db/dashboard'
import Link from 'next/link'

import { Duration } from '../../../components/duration.tsx'
import { EmptyState } from '../../../components/empty-state.tsx'
import { PanelCaveat } from '../../../components/panel-caveat.tsx'
import { Badge } from '../../../components/ui/badge.tsx'
import { Card, CardContent } from '../../../components/ui/card.tsx'
import { cn } from '../../../lib/utils.ts'
import { metricLabel } from '../../../lib/format.ts'
import { withWorkspace } from '../../../server/db.ts'

/**
 * The creative gallery.
 *
 * Sorted by survival, not by recency, because "what has this competitor kept paying to run"
 * is the only signal we have and the only one we claim. Nothing on this page is a
 * performance measure: we do not have impressions, spend or conversions, and implying we do
 * would be the single worst thing this product could say (rule 7).
 */

const SORTS: { value: GallerySort; label: string }[] = [
  { value: 'longest', label: 'Mayor supervivencia' },
  { value: 'newest', label: 'Más recientes' },
  { value: 'recently-stopped', label: 'Retirados hace poco' },
]

const STATUSES = [
  { value: 'all', label: 'Todos' },
  { value: 'running', label: 'Activos' },
  { value: 'stopped', label: 'Retirados' },
] as const

type Search = { anunciante?: string; estado?: string; orden?: string }

function parseSort(raw: string | undefined): GallerySort {
  return SORTS.some((s) => s.value === raw) ? (raw as GallerySort) : 'longest'
}

function parseStatus(raw: string | undefined): 'running' | 'stopped' | 'all' {
  return raw === 'running' || raw === 'stopped' ? raw : 'all'
}

export default async function GalleryPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}): Promise<React.ReactElement> {
  const params = await searchParams
  const sort = parseSort(params.orden)
  const status = parseStatus(params.estado)
  // Read straight from the query string with no validation beyond the type: an id belonging
  // to another workspace simply matches nothing, because RLS filters the query. There is no
  // ownership check to write here and therefore none to forget.
  const advertiserId = params.anunciante

  const { health, creatives, advertisers } = await withWorkspace(async (db) => ({
    health: await getPanelHealth(db),
    advertisers: await listAdvertisers(db),
    creatives: await listCreatives(db, {
      sort,
      status,
      ...(advertiserId === undefined ? {} : { advertiserId }),
    }),
  }))

  const query = (next: Partial<Search>): string => {
    const merged = { anunciante: advertiserId, estado: status, orden: sort, ...next }
    const search = new URLSearchParams()
    if (merged.anunciante !== undefined) search.set('anunciante', merged.anunciante)
    if (merged.estado !== 'all') search.set('estado', String(merged.estado))
    if (merged.orden !== 'longest') search.set('orden', String(merged.orden))
    const s = search.toString()
    return s === '' ? '/creativos' : `/creativos?${s}`
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl">Creativos</h1>
        <p className="text-sm text-muted-foreground">
          Ordenados por supervivencia: cuánto tiempo el anunciante siguió pagando por
          mantenerlos al aire.
        </p>
      </header>

      <PanelCaveat health={health} />

      <div className="flex flex-col gap-3">
        <FilterRow label="Anunciante">
          <FilterLink href={query({ anunciante: undefined })} active={advertiserId === undefined}>
            Todos
          </FilterLink>
          {advertisers.map((a) => (
            <FilterLink
              key={a.id}
              href={query({ anunciante: a.id })}
              active={advertiserId === a.id}
            >
              {a.name} ({a.runningCount})
            </FilterLink>
          ))}
        </FilterRow>

        <FilterRow label="Estado">
          {STATUSES.map((s) => (
            <FilterLink key={s.value} href={query({ estado: s.value })} active={status === s.value}>
              {s.label}
            </FilterLink>
          ))}
        </FilterRow>

        <FilterRow label="Orden">
          {SORTS.map((s) => (
            <FilterLink key={s.value} href={query({ orden: s.value })} active={sort === s.value}>
              {s.label}
            </FilterLink>
          ))}
        </FilterRow>
      </div>

      {creatives.length === 0 ? (
        <EmptyState title="Ningún creativo con estos filtros">
          {health.totalCreatives === 0
            ? 'El panel todavía está vacío. Los creativos aparecen aquí después del primer rastreo sano de una lista activa.'
            : 'Hay creativos en el panel, pero ninguno coincide con la combinación de filtros. Prueba quitando el filtro de estado.'}
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {creatives.map((c) => (
            <li key={c.creativeId}>
              <Card className="h-full transition-colors duration-fast ease-brew hover:border-primary/50">
                <Link href={`/creativos/${c.creativeId}`} className="flex h-full flex-col">
                  <CardContent className="flex flex-1 flex-col gap-3 p-5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-foreground">{c.advertiserName}</span>
                      <Badge variant="neutral">{c.mediaType}</Badge>
                    </div>

                    <p className="line-clamp-3 flex-1 text-sm text-muted-foreground">
                      {c.firstLineTranscript ?? c.adCopy ?? 'Sin copia registrada'}
                    </p>

                    <Duration
                      daysActive={c.daysActive}
                      isCensored={c.isCensored}
                      hasGaps={c.hasGaps}
                      observationDays={c.observationDays}
                      withVerb
                    />

                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>Duración: {metricLabel(c.durationS, 's')}</span>
                      {/* One creative, many ad_archive_ids — the same asset run as several
                          ads. The count is here so the number is not mistaken for reach. */}
                      {c.variantCount > 1 && <span>{c.variantCount} variantes del mismo anuncio</span>}
                    </div>
                  </CardContent>
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FilterRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

/**
 * Filters are links, not client-side state. The URL is then shareable, back works, and the
 * page stays a server component with no client bundle at all.
 */
function FilterLink({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={cn(
        // h-11 is 44px. A filter chip is a real touch target even though it reads as
        // secondary chrome, and the text being small is not a reason to make the hit area
        // small (DashOne §2).
        'flex h-11 items-center rounded-pill px-4 text-xs transition-colors duration-fast ease-brew',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </Link>
  )
}
