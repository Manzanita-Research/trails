export type SetupRequest =
  | { readonly mode: "hub"; readonly name?: string; readonly service?: string }
  | { readonly mode: "join"; readonly server: string; readonly name?: string }

export interface SetupActions {
  readonly configureCollector: (server: string, name?: string) => void
  readonly install: (kind: "server" | "collector", service?: string) => Promise<void>
  readonly collect: () => Promise<void>
  readonly waitForServer: (server: string) => Promise<void>
  readonly tailnetUrl: (service?: string) => string
}

const HUB_LOOPBACK_URL = "http://127.0.0.1:7412/"

export async function runSetup(request: SetupRequest, actions: SetupActions): Promise<string> {
  if (request.mode === "hub") {
    actions.configureCollector(HUB_LOOPBACK_URL, request.name)
    await actions.install("server", request.service)
    await actions.waitForServer(HUB_LOOPBACK_URL)
    await actions.collect()
    await actions.install("collector")
    const url = actions.tailnetUrl(request.service)
    if (request.service) await actions.waitForServer(url)
    return url
  }

  await actions.waitForServer(request.server)
  actions.configureCollector(request.server, request.name)
  await actions.collect()
  await actions.install("collector")
  return request.server
}
