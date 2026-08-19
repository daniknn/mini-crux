import { OrganizationSwitcher, UserButton } from '@clerk/nextjs'

import { Nav } from '../../components/nav.tsx'

/**
 * The shell every dashboard surface sits in.
 *
 * `OrganizationSwitcher` is the only place the tenant can be changed, and changing it
 * changes the session — not a URL parameter. That is what keeps `withWorkspace` able to read
 * the workspace from `auth()` alone.
 */
export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-black/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-6">
          <span className="font-display text-base text-foreground">Mini Crux</span>
          <Nav />
          <div className="ml-auto flex items-center gap-3">
            <OrganizationSwitcher
              hidePersonal
              appearance={{ elements: { rootBox: 'flex items-center' } }}
            />
            <UserButton />
          </div>
        </div>
      </header>

      {/* `main` so keyboard and screen-reader users can skip the chrome. */}
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  )
}
