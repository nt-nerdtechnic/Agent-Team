// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { useRoles, type Role } from '../useRoles'
import { createMockBackend, withScope, flush } from './mockBackend'

const pm: Role = {
  key: 'pm', label: 'Project Manager', one_line: 'plans the work', system_prompt: '# Role: PM',
  is_default: true,
}
const dev: Role = {
  key: 'dev', label: 'Developer', one_line: 'writes the code', system_prompt: '# Role: Dev',
  is_default: true,
}
const mockRoles: Role[] = [pm, dev]

function connected(roles: Role[] = mockRoles) {
  const mock = createMockBackend('connected')
  mock.setResponse('roles.list', { roles, path: '/data/roles.json' })
  return mock
}

describe('useRoles', () => {
  it('loads roles on connect', async () => {
    const mock = connected()
    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    expect(result.roles.value).toHaveLength(2)
    expect(result.path.value).toBe('/data/roles.json')
    expect(result.loaded.value).toBe(true)
    expect(result.error.value).toBe('')
    scope.stop()
  })

  it('does not load until the backend is connected', async () => {
    const mock = createMockBackend('disconnected')
    mock.setResponse('roles.list', { roles: mockRoles, path: '/data/roles.json' })

    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    expect(mock.sent.filter((s) => s.type === 'roles.list')).toHaveLength(0)
    expect(result.loaded.value).toBe(false)
    scope.stop()
  })

  it('records the error when roles.list fails', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('roles.list', null, { ok: false, error: { code: 'ERR', message: 'no file' } })

    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    expect(result.error.value).toBe('no file')
    expect(result.loaded.value).toBe(false)
    scope.stop()
  })

  it('updates the cache on a roles.changed broadcast', async () => {
    const mock = connected()
    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    const qa: Role = { key: 'qa', label: 'QA', one_line: 'tests it', system_prompt: '# Role: QA' }
    mock.emit('roles.changed', { roles: [...mockRoles, qa] })
    await flush()

    expect(result.roles.value).toHaveLength(3)
    expect(result.find('qa')?.label).toBe('QA')
    scope.stop()
  })

  it('upsert returns the role and refreshes the list', async () => {
    const mock = connected()
    const qa: Role = { key: 'qa', label: 'QA', one_line: 'tests it', system_prompt: '# Role: QA' }
    mock.setResponse('roles.upsert', { role: qa, roles: [...mockRoles, qa] })

    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    const role = await result.upsert({
      key: 'qa', label: 'QA', one_line: 'tests it', system_prompt: '# Role: QA',
    })
    expect(role?.key).toBe('qa')
    expect(result.roles.value).toHaveLength(3)
    expect(result.error.value).toBe('')

    const sent = mock.sent.find((s) => s.type === 'roles.upsert')
    expect(sent?.payload).toEqual({
      key: 'qa', label: 'QA', one_line: 'tests it', system_prompt: '# Role: QA',
    })
    scope.stop()
  })

  it('upsert resolves to null and sets error when the backend rejects it', async () => {
    // The whole point: failures never throw, so callers MUST check the return
    // value — a try/catch around upsert() will not see a backend rejection.
    const mock = connected()
    mock.setResponse('roles.upsert', null, {
      ok: false, error: { code: 'ERR', message: 'key already exists' },
    })

    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    let threw = false
    let role: Role | null = pm
    try {
      role = await result.upsert({
        key: 'pm', label: 'PM', one_line: '', system_prompt: 'x',
      })
    } catch { threw = true }

    expect(threw).toBe(false)
    expect(role).toBeNull()
    expect(result.error.value).toBe('key already exists')
    // The cache must keep the last known-good list.
    expect(result.roles.value).toHaveLength(2)
    scope.stop()
  })

  it('upsert falls back to a generic message when the error carries none', async () => {
    const mock = connected()
    mock.setResponse('roles.upsert', null, { ok: false })

    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    expect(await result.upsert({ key: 'x', label: 'X', one_line: '', system_prompt: 'x' })).toBeNull()
    expect(result.error.value).toBe('upsert failed')
    scope.stop()
  })

  it('remove returns true and refreshes the list', async () => {
    const mock = connected()
    mock.setResponse('roles.delete', { roles: [pm] })

    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    expect(await result.remove('dev')).toBe(true)
    expect(result.roles.value).toHaveLength(1)
    expect(mock.sent.find((s) => s.type === 'roles.delete')?.payload).toEqual({ key: 'dev' })
    scope.stop()
  })

  it('remove returns false and sets error when the backend rejects it', async () => {
    const mock = connected()
    mock.setResponse('roles.delete', null, {
      ok: false, error: { code: 'ERR', message: 'role is in use' },
    })

    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    expect(await result.remove('dev')).toBe(false)
    expect(result.error.value).toBe('role is in use')
    expect(result.roles.value).toHaveLength(2)
    scope.stop()
  })

  it('reset returns true and replaces the list with the defaults', async () => {
    const mock = connected([{ key: 'custom', label: 'Custom', one_line: '', system_prompt: 'x' }])
    mock.setResponse('roles.reset', { roles: mockRoles })

    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    expect(await result.reset()).toBe(true)
    expect(result.roles.value.map((r) => r.key)).toEqual(['pm', 'dev'])
    scope.stop()
  })

  it('reset returns false and sets error when the backend rejects it', async () => {
    const mock = connected()
    mock.setResponse('roles.reset', null, {
      ok: false, error: { code: 'ERR', message: 'write failed' },
    })

    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    expect(await result.reset()).toBe(false)
    expect(result.error.value).toBe('write failed')
    expect(result.roles.value).toHaveLength(2)
    scope.stop()
  })

  it('find looks a role up by key', async () => {
    const mock = connected()
    const { result, scope } = withScope(() => useRoles(mock.backend))
    await flush()

    expect(result.find('pm')?.label).toBe('Project Manager')
    expect(result.find('nope')).toBeUndefined()
    scope.stop()
  })
})
