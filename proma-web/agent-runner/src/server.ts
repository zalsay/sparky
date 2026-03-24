import express from 'express'
import type { Request, Response } from 'express'
import { SessionActionError, SessionManager } from './session-manager.js'
import type {
  ClaudeRuntimeStreamEvent,
  ConnectRunnerSessionInput,
  CreateRunnerSessionInput,
  RunnerHealthResponse,
  RunnerMessageInput,
} from './types.js'

const app = express()
const port = Number(process.env.PORT || '3210')
const sessionManager = new SessionManager()

app.use(express.json())

app.get('/health', (_req, res) => {
  const payload: RunnerHealthResponse = {
    status: 'healthy',
    service: 'proma-agent-runner',
    version: '0.1.0',
    sdkReady: true,
    checkedAt: new Date().toISOString(),
  }
  res.json(payload)
})

app.post('/internal/sessions', async (req, res, next) => {
  try {
    const input = req.body as CreateRunnerSessionInput
    if (!input?.workspaceId || !input?.name || !input?.channelId || !input?.modelId || !input?.runtimeConfig?.apiKey) {
      res.status(400).json({ error: 'missing workspaceId, name, channelId, modelId or runtimeConfig.apiKey' })
      return
    }
    res.status(201).json(await sessionManager.createSession(input))
  } catch (error) {
    next(error)
  }
})

app.get('/internal/sessions/:id', (req, res, next) => {
  try {
    const session = sessionManager.getSession(req.params.id)
    if (!session) {
      res.status(404).json({ error: 'agent session not found' })
      return
    }
    res.json(session)
  } catch (error) {
    next(error)
  }
})

app.post('/internal/sessions/:id/connect', async (req, res, next) => {
  try {
    res.json(await sessionManager.connectSession(req.params.id, (req.body ?? {}) as ConnectRunnerSessionInput))
  } catch (error) {
    next(error)
  }
})

app.post('/internal/sessions/:id/messages', async (req, res, next) => {
  try {
    const input = req.body as RunnerMessageInput
    if (!input?.content || !String(input.content).trim()) {
      res.status(400).json({ error: 'missing content' })
      return
    }
    res.json(await sessionManager.sendMessage(req.params.id, { content: String(input.content) }))
  } catch (error) {
    next(error)
  }
})

app.post('/internal/sessions/:id/messages/stream', async (req, res, next) => {
  try {
    const input = req.body as RunnerMessageInput
    if (!input?.content || !String(input.content).trim()) {
      res.status(400).json({ error: 'missing content' })
      return
    }
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders()
    }

    for await (const event of sessionManager.streamMessageEvents(req.params.id, { content: String(input.content) })) {
      await writeRunnerStreamEvent(res, event)
    }
    res.end()
  } catch (error) {
    next(error)
  }
})

app.post('/internal/sessions/:id/close', async (req, res, next) => {
  try {
    res.json(await sessionManager.closeSession(req.params.id))
  } catch (error) {
    next(error)
  }
})

app.post('/internal/sessions/:id/restart', async (req, res, next) => {
  try {
    res.json(await sessionManager.restartSession(req.params.id))
  } catch (error) {
    next(error)
  }
})

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof SessionActionError) {
    res.status(error.statusCode).json({ error: error.message })
    return
  }
  const message = error instanceof Error ? error.message : 'internal server error'
  res.status(500).json({ error: message })
})

app.listen(port, '0.0.0.0', () => {
  console.log(`proma-agent-runner listening on :${port}`)
})

async function writeRunnerStreamEvent(res: Response, event: ClaudeRuntimeStreamEvent): Promise<void> {
  await writeSSEEvent(res, 'message', event)
}

async function writeSSEEvent(res: Response, event: string, payload: unknown): Promise<void> {
  const encoded = JSON.stringify(payload)
  await new Promise<void>((resolve, reject) => {
    res.write(`event: ${event}\ndata: ${encoded}\n\n`, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
