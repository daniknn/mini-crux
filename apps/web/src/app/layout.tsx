import { ClerkProvider } from '@clerk/nextjs'
import { esMX } from '@clerk/localizations'
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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    // `esMX` localizes Clerk's own UI; our copy is Mexican Spanish throughout (rule 12).
    <ClerkProvider localization={esMX}>
      <html lang="es-MX" className="dark">
        <body className={`${sans.variable} ${display.variable} ${mono.variable}`}>
          {children}
        </body>
      </html>
    </ClerkProvider>
  )
}
