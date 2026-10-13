import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { LIVE_MODEL, startLive, until, type LiveServer } from "./harness"

let server: LiveServer

beforeAll(async () => {
  server = await startLive()
}, 60_000)

afterAll(async () => {
  await server?.stop()
})

describe("live: native question tool in an ordinary session", () => {
  test("the model's question tool call creates a renderable form", async () => {
    // Capture every form.* event while we prompt.
    const seen: any[] = []
    const controller = new AbortController()
    const pump = (async () => {
      for await (const event of server.client.event.subscribe({ signal: controller.signal })) {
        const type = (event as any)?.type ?? ""
        if (type.startsWith("form.") || type.startsWith("question.")) {
          seen.push({ type, hasLocation: (event as any).location != null, data: (event as any).data })
        }
      }
    })().catch(() => {})

    const [providerID, id] = LIVE_MODEL.split("/", 2) as [string, string]
    const session = await server.client.session.create({
      title: "native question repro",
      agent: "build",
      model: { providerID, id },
      location: { directory: server.project },
    } as never)

    // Prompt WITHOUT waiting: a pending question blocks the session.
    await server.client.session.prompt({
      sessionID: session.id,
      text: 'Use the question tool exactly once. Ask "Pick a colour" with the options "red" and "blue". Do not do anything else.',
    } as never)

    // Poll for the native form the client would render.
    const forms = await until(async () => {
      const list = await server.client.session.form.list({ sessionID: session.id } as never)
      return list.length > 0 ? list : undefined
    }, 90_000).catch(() => [] as any[])

    controller.abort()
    await pump

    // Did the model actually call the question tool? (Distinguish "no tool call" from "tool called, no form".)
    const messages = (await server.client.session.context({ sessionID: session.id } as never)) as any[]
    const questionParts: any[] = []
    const partTypes: string[] = []
    for (const message of messages) {
      for (const part of message?.content ?? []) {
        partTypes.push(part.type === "tool" ? `tool:${part.name}` : part.type)
        if (part.type === "tool" && part.name === "question") {
          questionParts.push({ status: part.state?.status, input: part.state?.input, error: part.state?.error })
        }
      }
    }

    console.log("[repro] model =", LIVE_MODEL)
    console.log("[repro] part types =", JSON.stringify(partTypes))
    console.log("[repro] forms created =", JSON.stringify(forms, null, 2))
    console.log("[repro] form events =", JSON.stringify(seen, null, 2))
    console.log("[repro] question tool parts =", JSON.stringify(questionParts, null, 2))

    // The model must have called the tool for this test to mean anything.
    expect(questionParts.length).toBeGreaterThan(0)
    // A native form must exist...
    expect(forms.length).toBeGreaterThan(0)
    // ...and its `form.created` event must carry a location, or a location-scoped client (every
    // ordinary session) drops it and the options never render. This is the actual issue #17 signal.
    const created = seen.filter((e) => e.type === "form.created")
    expect(created.length).toBeGreaterThan(0)
    expect(created.every((e) => e.hasLocation)).toBe(true)
  }, 150_000)
})
