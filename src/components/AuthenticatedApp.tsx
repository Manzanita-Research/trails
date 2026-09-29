import { useEffect, useState } from "react"
import { App } from "../App"

export function AuthenticatedApp() {
  const [signedIn, setSignedIn] = useState(false)
  const [checking, setChecking] = useState(true)
  const [token, setToken] = useState("")
  const [error, setError] = useState("")
  useEffect(() => {
    const check = () => fetch("/api/auth/session", { cache: "no-store" })
      .then(response => setSignedIn(response.ok))
      .catch(() => setError("Could not reach the hub."))
      .finally(() => setChecking(false))
    void check()
    const interval = setInterval(check, 30_000)
    return () => clearInterval(interval)
  }, [])
  if (checking) return <main>Connecting to Trails…</main>
  if (signedIn) return <>
    <button type="button" onClick={async () => {
      const response = await fetch("/api/auth/logout", { method: "POST" })
      if (response.ok) setSignedIn(false)
    }}>Sign out</button>
    <App />
  </>
  return <main className="welcome-view">
    <h1>Sign in to Trails</h1>
    <p>On your hub, run <code>trails auth owner</code>, then paste the owner credential here.</p>
    <form onSubmit={async event => {
      event.preventDefault()
      try {
        const response = await fetch("/api/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
        })
        if (!response.ok) { setError("Sign-in failed. Check your owner credential."); return }
        setToken("")
        setError("")
        setSignedIn(true)
      } catch { setError("Could not reach the hub.") }
    }}>
      <label>Owner credential <input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required /></label>
      <button type="submit">Sign in</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </main>
}
