import { SignIn } from '@clerk/nextjs'

export default function SignInPage(): React.ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <SignIn />
    </main>
  )
}
