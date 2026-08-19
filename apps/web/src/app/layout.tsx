import type { Metadata } from 'next'
import { Fraunces, Hanken_Grotesk, JetBrains_Mono } from 'next/font/google'

import './globals.css'

// Daily Brew typography (DashOne §2), loaded through next/font so there is no layout
// shift and no third-party request at runtime.
const sans = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-sans', display: 'swap' })
const display = Fraunces({ subsets: ['latin'], variable: '--font-display', display: 'swap' })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' })

export const metadata: Metadata = {
  title: 'Mini Crux',
  description: 'Inteligencia de creativos publicitarios para el mercado mexicano.',
}

/**
 * Fonts, tokens, and the document. Nothing else.
 *
 * WHY `ClerkProvider` IS NOT HERE
 *
 * Next allows a second root layout only when there is no `app/layout.tsx` above it, and this
 * is that file — so every route group in the app inherits whatever this layout wraps,
 * including `(preview)`. With `ClerkProvider` here, opening `/ux` boots Clerk: in keyless
 * mode that means provisioning a throwaway dev instance over the network, for a provider no
 * preview surface uses. A design review that fails when Clerk is unreachable is a bad trade
 * (UC-10).
 *
 * So the provider sits in the two subtrees whose components actually need it —
 * `(dashboard)/layout.tsx` for `OrganizationSwitcher` and `UserButton`, `sign-in/layout.tsx`
 * for `<SignIn/>`. `auth()` is unaffected: it reads the request on the server and has never
 * needed a React provider.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="es-MX" className="dark">
      <body className={`${sans.variable} ${display.variable} ${mono.variable}`}>{children}</body>
    </html>
  )
}
