/** Exact externally visible origins, including the port, never inferred from a request. */
export function localOrigins(port: number): string[] {
  return ["127.0.0.1", "localhost", "[::1]"].map((host) => `http://${host}:${port}`)
}

export function normalizeTrustedOrigin(value: string): string {
  if (!/^https?:\/\/(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::[0-9]+)?\/?$/.test(value)) {
    throw new Error("trusted origin must be an exact HTTP(S) origin without credentials, path, query, or fragment")
  }
  return new URL(value).origin
}

export function createRequestBoundary(trustedOrigins: readonly string[]) {
  const originsByAuthority = new Map<string, Set<string>>()
  for (const value of trustedOrigins) {
    const origin = normalizeTrustedOrigin(value)
    const url = new URL(origin)
    // Explicit default ports are equivalent authorities in HTTP.
    const authorities = [url.host, `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`]
    for (const authority of authorities) {
      let origins = originsByAuthority.get(authority)
      if (!origins) originsByAuthority.set(authority, (origins = new Set()))
      origins.add(origin)
    }
  }

  return (request: Request, url: URL): "untrusted_host" | "untrusted_origin" | null => {
    // Bun derives request.url from Host. Check both for direct handler callers too.
    // Forwarded / X-Forwarded-* never grant trust, even on a loopback connection.
    const authority = (request.headers.get("host") ?? url.host).toLowerCase()
    const origins = originsByAuthority.get(authority)
    const urlOrigins = originsByAuthority.get(url.host.toLowerCase())
    if (!origins || !urlOrigins || ![...origins].some((origin) => urlOrigins.has(origin))) {
      return "untrusted_host"
    }
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null

    const origin = request.headers.get("origin")
    // Compare the serialized origin exactly: null, lists and malformed origins fail.
    // Use the configured public scheme for a TLS-terminating Tailscale proxy.
    if (origin !== null && !origins.has(origin)) return "untrusted_origin"
    const site = request.headers.get("sec-fetch-site")
    if (site !== null && site !== "same-origin") return "untrusted_origin"
    const browserMetadata = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"]
      .some((header) => request.headers.has(header))
    if (browserMetadata && origin === null) return "untrusted_origin"
    // Native collectors have no Origin or Fetch Metadata. Authentication is separate.
    return null
  }
}
