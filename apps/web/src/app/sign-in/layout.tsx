import { ClerkProvider } from '@clerk/nextjs'
import { esMX } from '@clerk/localizations'

/**
 * `<SignIn/>` is a Clerk client component and needs the provider; the root layout no longer
 * supplies one, so that `/ux` can render without booting Clerk at all (UC-10).
 */
export default function SignInLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return <ClerkProvider localization={esMX}>{children}</ClerkProvider>
}
