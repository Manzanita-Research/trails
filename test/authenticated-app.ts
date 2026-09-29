// Existing route/domain tests run as explicitly provisioned clients. Authentication
// rejection tests use the production createApp directly in auth.test.ts.
import { createApp as productionApp, type AppOptions } from "../server/app"
import { issueCredential } from "../server/auth"
export { bootstrapOf, setAdvertisedHubUrl } from "../server/app"
export function createApp(options: AppOptions) {
  const owner = issueCredential(options.db, "owner")
  const collectors = new Map<string, string>()
  const app = productionApp(options)
  return async (request: Request) => {
    let token = owner.token
    if (["/api/ingest", "/api/captures", "/api/collector-status"].includes(new URL(request.url).pathname)) {
      let id = "invalid-body-fixture"
      try { id = (await request.clone().json() as { device?: { id?: string } }).device?.id ?? id } catch {}
      if (!collectors.has(id)) collectors.set(id, issueCredential(options.db, "collector", id).token)
      token = collectors.get(id)!
    }
    const headers = new Headers(request.headers)
    headers.set("Authorization", `Bearer ${token}`)
    return app(new Request(request, { headers }))
  }
}
