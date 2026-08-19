import { notFound } from 'next/navigation'
import Link from 'next/link'

import { Nav } from '../../components/nav.tsx'
import { isPreviewEnabled } from './gate.ts'

/**
 * The `/ux` design-review shell.
 *
 * WHY THIS TREE IS SAFE
 *
 * Not because of the `NODE_ENV` check below — because of what is missing from the import
 * graph. Nothing under `(preview)/` imports `server/`, `@clerk/*`, `@mini-crux/db`, or a
 * Supabase client, so there is no code path from any of these routes to a credential, a
 * connection or a session. It has nothing to leak. `preview-isolation.test.ts` walks the
 * graph and fails if that ever stops being true; the check below is the second line, not the
 * first (`specs/UC-10-ux-preview.md` §1).
 *
 * WHY THE CHROME IS THE REAL CHROME
 *
 * Same header, same `Nav`, same `max-w-7xl` main as `(dashboard)/layout.tsx`. A preview that
 * renders the surfaces inside different chrome is a review of something the product does not
 * ship. What differs is what has to differ: no `OrganizationSwitcher` and no `UserButton`
 * (both are Clerk client components), and the banner below.
 */
export default function PreviewLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  if (!isPreviewEnabled()) notFound()

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-black/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-6">
          <Link href="/ux" className="font-display text-base text-foreground">
            Mini Crux
          </Link>
          <Nav basePath="/ux" />
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 pt-6">
        <PreviewBanner />
      </div>

      {/* `main` so keyboard and screen-reader users can skip the chrome. */}
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  )
}

/**
 * Said on every page, not once on the index.
 *
 * A reviewer arrives at `/ux/analisis` from a link, screenshots the card, and the screenshot
 * outlives the tab. The numbers here are invented and the forms do nothing; a banner that
 * only exists on the index is a banner that is not there when it matters.
 */
function PreviewBanner(): React.ReactElement {
  return (
    <p
      role="note"
      className="rounded-lg border border-primary/40 bg-primary/10 px-5 py-3 text-sm text-foreground"
    >
      <strong className="font-medium">Vista previa de diseño.</strong> Todos los datos de esta
      pantalla son inventados y los controles no hacen nada — no hay base de datos detrás. Sirve
      para revisar tipografía, contraste, espaciado y foco, no para leer el panel.
    </p>
  )
}
