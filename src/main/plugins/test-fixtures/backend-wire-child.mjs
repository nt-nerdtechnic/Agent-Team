const PROTOCOL_REVISION = '2026-07-28'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'

const pendingDelays = new Map()
let cancelledCount = 0
let input = Buffer.alloc(0)

function isRequestId(value) {
  return (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isInteger(value))
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isClientMeta(value) {
  return isRecord(value) &&
    value['io.modelcontextprotocol/protocolVersion'] === PROTOCOL_REVISION &&
    isRecord(value['io.modelcontextprotocol/clientCapabilities'])
}

function isRuntime(value) {
  return exactKeys(value, [
    'pluginId',
    'packageVersion',
    'workspaceId',
    'instanceId',
    'contributionKey',
    'hostWindowId',
  ]) &&
    typeof value.pluginId === 'string' && value.pluginId.length > 0 &&
    typeof value.packageVersion === 'string' && value.packageVersion.length > 0 &&
    ['workspaceId', 'instanceId', 'contributionKey', 'hostWindowId']
      .every((key) => value[key] === null || typeof value[key] === 'string')
}

function scanString(text, start) {
  let index = start + 1
  while (index < text.length) {
    const character = text[index]
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === '"') return index + 1
    index += 1
  }
  throw new Error('unterminated string')
}

function scanValue(text, start, keys) {
  const character = text[start]
  if (character === '"') return scanString(text, start)
  if (character === '[') {
    let index = start + 1
    if (text[index] === ']') return index + 1
    while (true) {
      index = scanValue(text, index, keys)
      if (text[index] === ']') return index + 1
      if (text[index] !== ',') throw new Error('invalid array')
      index += 1
    }
  }
  if (character === '{') {
    const seen = new Set()
    let index = start + 1
    if (text[index] === '}') return index + 1
    while (true) {
      if (text[index] !== '"') throw new Error('invalid object key')
      const keyEnd = scanString(text, index)
      const key = JSON.parse(text.slice(index, keyEnd))
      if (seen.has(key)) throw new Error('duplicate object key')
      seen.add(key)
      index = keyEnd
      if (text[index] !== ':') throw new Error('invalid object')
      index = scanValue(text, index + 1, keys)
      if (text[index] === '}') return index + 1
      if (text[index] !== ',') throw new Error('invalid object')
      index += 1
    }
  }
  let index = start
  while (index < text.length && !',]}'.includes(text[index])) index += 1
  return index
}

function parseStrict(line) {
  if (line.length === 0) throw new Error('empty frame')
  let inString = false
  let escaped = false
  for (const character of line) {
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\' && inString) {
      escaped = true
      continue
    }
    if (character === '"') {
      inString = !inString
      continue
    }
    if (!inString && /[\t\r\n ]/.test(character)) throw new Error('non-compact frame')
  }
  const end = scanValue(line, 0, new Set())
  if (end !== line.length) throw new Error('trailing frame data')
  return JSON.parse(line)
}

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function writeProtocolError(id) {
  const frame = { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' } }
  if (isRequestId(id)) frame.id = id
  writeFrame(frame)
}

function response(id, value) {
  writeFrame({
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      value,
      _meta: { [SERVER_INFO_KEY]: { name: 'fixture.backend', version: '1.0.0' } },
    },
  })
}

function isHealthRequest(frame) {
  return exactKeys(frame, ['jsonrpc', 'id', 'method', 'params']) &&
    frame.jsonrpc === '2.0' &&
    isRequestId(frame.id) &&
    frame.method === 'navide/health' &&
    exactKeys(frame.params, ['_meta']) &&
    isClientMeta(frame.params._meta)
}

function isCallRequest(frame) {
  return exactKeys(frame, ['jsonrpc', 'id', 'method', 'params']) &&
    frame.jsonrpc === '2.0' &&
    isRequestId(frame.id) &&
    frame.method === 'navide/call' &&
    exactKeys(frame.params, ['_meta', 'name', 'arguments', 'runtime']) &&
    isClientMeta(frame.params._meta) &&
    typeof frame.params.name === 'string' &&
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/.test(frame.params.name) &&
    isRuntime(frame.params.runtime)
}

function handle(frame) {
  if (frame?.jsonrpc === '2.0' && frame.method === 'notifications/cancelled') {
    if (!exactKeys(frame, ['jsonrpc', 'method', 'params']) ||
      !exactKeys(frame.params, ['requestId']) ||
      !isRequestId(frame.params.requestId)) {
      writeProtocolError(undefined)
      return
    }
    const timer = pendingDelays.get(String(frame.params.requestId))
    if (timer) {
      clearTimeout(timer)
      pendingDelays.delete(String(frame.params.requestId))
      cancelledCount += 1
    }
    return
  }

  if (!isHealthRequest(frame) && !isCallRequest(frame)) {
    writeProtocolError(frame?.id)
    return
  }

  if (frame.method === 'navide/health') {
    response(frame.id, {
      method: frame.method,
      protocolVersion: frame.params._meta['io.modelcontextprotocol/protocolVersion'],
      requestIdIsNonNull: frame.id !== null,
      clientCapabilities: frame.params._meta['io.modelcontextprotocol/clientCapabilities'],
    })
    return
  }

  const { name, arguments: args } = frame.params
  if (name === 'fixture.echo') {
    response(frame.id, { arguments: args, runtime: frame.params.runtime })
    return
  }
  if (name === 'fixture.publicerror') {
    writeFrame({
      jsonrpc: '2.0',
      id: frame.id,
      error: {
        code: 1000,
        message: 'Public plugin error',
        data: { code: 'INVALID_ARGUMENT', details: { retryable: false } },
      },
    })
    return
  }
  if (name === 'fixture.protocolerror') {
    writeFrame({
      jsonrpc: '2.0',
      id: frame.id,
      error: { code: -32601, message: 'Method not found' },
    })
    return
  }
  if (name === 'fixture.delay') {
    const milliseconds = isRecord(args) && typeof args.milliseconds === 'number'
      ? args.milliseconds
      : 100
    const key = String(frame.id)
    pendingDelays.set(key, setTimeout(() => {
      pendingDelays.delete(key)
      response(frame.id, { delayed: true })
    }, milliseconds))
    return
  }
  if (name === 'fixture.cancelcount') {
    response(frame.id, cancelledCount)
    return
  }
  if (name === 'fixture.lateresponse') {
    const requestId = isRecord(args) ? args.requestId : undefined
    if (!isRequestId(requestId)) {
      writeProtocolError(frame.id)
      return
    }
    response(requestId, { late: true })
    response(frame.id, { ok: true })
    return
  }
  if (name === 'fixture.exit') {
    process.exit(17)
    return
  }
  if (name === 'fixture.stderr') {
    process.stderr.write('fixture diagnostic: /private/internal/path\n')
    response(frame.id, { ok: true })
    return
  }
  if (name === 'fixture.badversion') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.1',
      id: frame.id,
      result: {
        resultType: 'complete',
        value: true,
        _meta: { [SERVER_INFO_KEY]: { name: 'fixture.backend', version: '1.0.0' } },
      },
    }) + '\n')
    return
  }
  if (name === 'fixture.duplicatekeys') {
    process.stdout.write(`{"jsonrpc":"2.0","id":${JSON.stringify(frame.id)},"result":{"resultType":"complete","value":true,"_meta":{"${SERVER_INFO_KEY}":{"name":"fixture.backend","version":"1.0.0"}}},"result":{}}\n`)
    return
  }
  if (name === 'fixture.multiline') {
    process.stdout.write('{"jsonrpc":"2.0",\n')
    process.stdout.write(`"id":${JSON.stringify(frame.id)},"result":{"resultType":"complete","value":true,"_meta":{"${SERVER_INFO_KEY}":{"name":"fixture.backend","version":"1.0.0"}}}}\n`)
    return
  }
  if (name === 'fixture.unknownmethod') {
    writeFrame({ jsonrpc: '2.0', id: frame.id, method: 'tools/list', params: {} })
    return
  }
  if (name === 'fixture.forgedruntime') {
    writeFrame({
      jsonrpc: '2.0',
      id: frame.id,
      runtime: { pluginId: 'forged.plugin' },
      result: {
        resultType: 'complete',
        value: true,
        _meta: { [SERVER_INFO_KEY]: { name: 'fixture.backend', version: '1.0.0' } },
      },
    })
    return
  }

  writeFrame({
    jsonrpc: '2.0',
    id: frame.id,
    error: { code: -32601, message: 'Method not found' },
  })
}

function failClosed() {
  process.exitCode = 2
  process.stdin.destroy()
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  while (true) {
    const newline = input.indexOf(0x0a)
    if (newline < 0) return
    const line = input.subarray(0, newline).toString('utf8')
    input = input.subarray(newline + 1)
    try {
      handle(parseStrict(line))
    } catch {
      failClosed()
      return
    }
  }
})

process.stdin.on('end', () => {
  if (input.length !== 0) failClosed()
})
