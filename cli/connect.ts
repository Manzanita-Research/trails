import { createInterface, type Interface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { isProviderId, PROVIDER_IDS, PROVIDERS, type ProviderId } from "../shared/providers"
import { createConnectorControl, type ConnectorControl } from "../server/connectors/control"
import { createSummarizerManager } from "../server/connectors/manager"

export type ConnectorCommand = "connect" | "use" | "logout" | "disconnect"

export interface ConnectorCliOptions {
  readonly control?: ConnectorControl
  readonly print?: (message: string) => void
  readonly prompt?: (message: string) => Promise<string>
  readonly readStdin?: () => Promise<string>
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly openrouterLogin?: (
    control: ConnectorControl,
    print: (message: string) => void,
  ) => Promise<void>
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function requireProvider(value: string | undefined): ProviderId {
  if (!value || !isProviderId(value)) throw new Error("provider must be openrouter, chatgpt, or openai-api")
  return value
}

function consentFor(provider: ProviderId): string {
  const info = PROVIDERS[provider]
  const billing = provider === "chatgpt" ? "your ChatGPT subscription" : `your ${info.company} account`
  return [
    `Activating ${info.label} sends bounded session and day digests (up to 9,000/12,000 characters) to ${info.company}.`,
    "Trails never sends transcripts, files, database contents, or collector traffic.",
    `Usage is billed to ${billing}.${info.unofficial ? " This ChatGPT connection is unofficial." : ""}`,
  ].join(" ")
}

function failureMessage(errorClass: string): string {
  switch (errorClass) {
    case "auth_required":
      return "Provider login expired or was denied. Start the login again."
    case "quota":
      return "The provider reported a quota or billing limit."
    case "timeout":
      return "The provider login timed out."
    case "network":
      return "The provider could not be reached."
    default:
      return "The provider login failed."
  }
}

async function defaultOpenrouterLogin(
  control: ConnectorControl,
  print: (message: string) => void,
): Promise<void> {
  let settle: (() => void) | null = null
  let fail: ((error: Error) => void) | null = null
  const completed = new Promise<void>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 })
      try {
        await control.finishOpenrouter(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "")
        settle?.()
        return new Response("OpenRouter is connected. You can close this window.", {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        })
      } catch {
        fail?.(new Error("OpenRouter login failed"))
        return new Response("OpenRouter login failed. Return to the terminal and try again.", { status: 400 })
      }
    },
  })
  try {
    const callbackUrl = `http://127.0.0.1:${server.port}/callback`
    const { authorizeUrl } = control.startOpenrouter(callbackUrl)
    print("Open this URL in a browser on the hub Mac:")
    print(authorizeUrl)
    await Promise.race([
      completed,
      Bun.sleep(10 * 60_000).then(() => {
        throw new Error("OpenRouter login timed out")
      }),
    ])
  } finally {
    server.stop(true)
  }
}

function statusLines(control: ConnectorControl): string[] {
  const status = control.status()
  const lines = status.providers.map((provider) => {
    const marker = provider.loggedIn ? "●" : "○"
    const notes = [provider.unofficial ? "unofficial" : null, provider.id === "openrouter" ? "recommended" : null]
      .filter(Boolean)
      .join(", ")
    return `${marker} ${provider.label}${notes ? ` — ${notes}` : ""}`
  })
  if (status.active) {
    lines.push(`Active: ${PROVIDERS[status.active.provider].label} · ${status.active.model} · ${status.active.state}`)
  } else {
    lines.push("Active: summaries off")
  }
  if (status.legacyRelay) lines.push("Legacy relay configuration is retired; connect a provider.")
  return lines
}

export async function runConnectorCommand(
  command: ConnectorCommand,
  args: string[],
  options: ConnectorCliOptions = {},
): Promise<void> {
  const control = options.control ?? createConnectorControl({ manager: createSummarizerManager() })
  const print = options.print ?? console.log
  const sleep = options.sleep ?? Bun.sleep
  const readStdin = options.readStdin ?? (() => Bun.stdin.text())
  const terminal: { current: Interface | null } = { current: null }
  const prompt = options.prompt ?? (async (message: string) => {
    terminal.current ??= createInterface({ input, output })
    return terminal.current.question(message)
  })

  try {
    if (command === "connect" && args[0] === "status") {
      for (const line of statusLines(control)) print(line)
      return
    }

    if (command === "connect") {
      let providerValue = args[0]
      if (!providerValue || providerValue.startsWith("--")) {
        print("Select provider to login:")
        for (const [index, id] of PROVIDER_IDS.entries()) {
          const info = PROVIDERS[id]
          const notes = [id === "openrouter" ? "recommended" : null, info.unofficial ? "unofficial" : null]
            .filter(Boolean)
            .join(", ")
          print(`${index + 1}. ${info.label}${notes ? ` — ${notes}` : ""}`)
        }
        const selected = Number(await prompt("Provider [1-3]: "))
        providerValue = PROVIDER_IDS[selected - 1]
      }
      const provider = requireProvider(providerValue)
      if (provider === "chatgpt") {
        print("ChatGPT subscription login is unofficial and uses OpenAI's Codex device flow.")
        const flow = await control.startChatgpt()
        print(`Open ${flow.verificationUrl}`)
        print(`Enter code: ${flow.userCode}`)
        while (true) {
          await sleep(flow.intervalSeconds * 1_000)
          const result = await control.pollChatgpt()
          if (result.state === "pending") continue
          if (result.state === "failed") throw new Error(failureMessage(result.errorClass))
          print("ChatGPT login stored on this hub. Run `trails use chatgpt` to activate it.")
          return
        }
      }
      if (args.includes("--api-key-stdin") || provider === "openai-api") {
        if (!args.includes("--api-key-stdin")) {
          throw new Error(`connect ${provider} requires --api-key-stdin`)
        }
        const key = await readStdin()
        control.setApiKey(provider, key)
        print(`${PROVIDERS[provider].label} credential stored on this hub. Run \`trails use ${provider}\` to activate it.`)
        return
      }
      await (options.openrouterLogin ?? defaultOpenrouterLogin)(control, print)
      print("OpenRouter login stored on this hub. Run `trails use openrouter` to activate it.")
      return
    }

    if (command === "use") {
      const provider = requireProvider(args[0])
      const model = valueAfter(args, "--model")
      print(consentFor(provider))
      if (!args.includes("--yes")) {
        const answer = (await prompt("Activate this provider? [y/N] ")).trim().toLowerCase()
        if (answer !== "y" && answer !== "yes") {
          print("No change.")
          return
        }
      }
      control.activate({ provider, ...(model ? { model } : {}) })
      print(`Summaries will use ${PROVIDERS[provider].label}${model ? ` · ${model}` : ""}.`)
      return
    }

    if (command === "logout") {
      const provider = requireProvider(args[0])
      control.logout(provider)
      print(`Logged out of ${PROVIDERS[provider].label}.`)
      return
    }

    control.disconnect()
    print("Summaries are off. Stored provider logins were kept.")
  } finally {
    terminal.current?.close()
  }
}
