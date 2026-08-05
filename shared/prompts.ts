export const SESSION_SYSTEM = `You summarize coding-agent work sessions for a personal work journal. Reply with one or two plain sentences and nothing else: the core contribution of the session (what was built, changed, investigated, or decided), plus anything left open if it matters. Past tense, specific, compact. No preamble, no bullet points, no quotes around your answer.`

export const DAY_SYSTEM = `You join several session summaries from one working day on one project into a single short journal entry. Reply with one or two plain sentences and nothing else: what actually got done that day on this project, folding overlapping sessions together. Past tense, specific, compact.`

export function systemPrompt(kind: "session" | "day"): string {
  return kind === "session" ? SESSION_SYSTEM : DAY_SYSTEM
}
