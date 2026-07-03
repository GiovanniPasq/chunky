import { describe, expect, it, vi } from 'vitest'
import { parseSse } from './parseSse'

const encoder = new TextEncoder()

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('parseSse', () => {
  it('parses frames split across network chunks', async () => {
    const events = []
    for await (const event of parseSse(streamOf(
      'data: {"type":"pro',
      'gress","current":1}\n\ndata: {"type":"done"}\n\n',
    ))) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'progress', current: 1 },
      { type: 'done' },
    ])
  })

  it('accepts CRLF-delimited SSE frames', async () => {
    const events = []
    for await (const event of parseSse(streamOf(
      'data: {"type":"done"}\r',
      '\n\r\n',
    ))) {
      events.push(event)
    }

    expect(events).toEqual([{ type: 'done' }])
  })

  it('skips malformed frames without losing the following event', async () => {
    const events = []
    for await (const event of parseSse(streamOf(
      'data: not-json\n\ndata: {"type":"done"}\n\n',
    ))) {
      events.push(event)
    }

    expect(events).toEqual([{ type: 'done' }])
  })

  it('cancels the reader when the consumer stops early', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"first"}\n\n'))
      },
      cancel,
    })

    for await (const event of parseSse(stream)) {
      expect(event).toEqual({ type: 'first' })
      break
    }

    expect(cancel).toHaveBeenCalledOnce()
  })
})
