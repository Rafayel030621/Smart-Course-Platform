import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWED_ORIGIN,
  INVITE_CODE,
  PASSWORD,
  TestClient,
  createTestClient,
  registerBody,
  registerUser,
  sessionFrom,
  uuid,
} from './v3-support.js'

/**
 * 账号、会话与 CORS（契约第 21 节）
 */

let client: TestClient

before(async () => {
  client = await createTestClient()
})

after(async () => {
  await client.close()
})

test('注册成功：返回用户信息、HttpOnly Cookie，不返回密码哈希', async () => {
  const body = registerBody()
  const response = await client.request('/api/auth/register', { method: 'POST', body })
  const parsed = (await response.json()) as Record<string, unknown>
  const user = parsed.user as Record<string, unknown>

  assert.equal(response.status, 200)
  assert.equal(parsed.contractVersion, '3.0')
  assert.equal(user.account, body.account)
  assert.equal(user.displayName, '张同学')
  assert.equal(user.status, 'active')
  assert.equal(user.revision, 1)
  assert.equal(parsed.passwordHash, undefined)
  assert.equal(user.passwordHash, undefined)
  assert.equal(typeof parsed.sessionExpiresAt, 'string')

  const setCookie = response.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /^scp_session=/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  assert.match(setCookie, /Path=\//)
  assert.match(setCookie, /Max-Age=604800/)
  assert.equal(setCookie.includes('Secure'), false)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('重复注册与邀请码错误统一返回 REGISTER_REJECTED，不泄露账号是否存在', async () => {
  const body = registerBody()
  const first = await client.request('/api/auth/register', { method: 'POST', body })
  assert.equal(first.status, 200)

  const duplicate = await client.request('/api/auth/register', {
    method: 'POST',
    body: registerBody({ account: body.account }),
  })
  const duplicateBody = (await duplicate.json()) as Record<string, unknown>
  assert.equal(duplicate.status, 409)
  assert.equal(duplicateBody.code, 'REGISTER_REJECTED')
  assert.equal(duplicateBody.message, '注册未完成，请检查用户名、密码和邀请码')
  assert.equal(duplicateBody.user, undefined)

  const wrongInvite = await client.request('/api/auth/register', {
    method: 'POST',
    body: registerBody({ inviteCode: 'WRONG-INVITE-CODE' }),
  })
  const wrongBody = (await wrongInvite.json()) as Record<string, unknown>
  assert.equal(wrongInvite.status, 409)
  assert.equal(wrongBody.code, 'REGISTER_REJECTED')
  assert.equal(wrongBody.message, duplicateBody.message)
})

test('登录成功轮换会话：旧 Cookie 失效，新 Cookie 可用', async () => {
  const user = await registerUser(client)
  const login = await client.request('/api/auth/login', {
    method: 'POST',
    cookie: user.cookie,
    body: {
      contractVersion: '3.0',
      requestId: uuid(),
      account: user.account,
      password: PASSWORD,
    },
  })
  assert.equal(login.status, 200)
  const newCookie = sessionFrom(login)
  assert.notEqual(newCookie, user.cookie)

  const oldSession = await client.request('/api/auth/me', { cookie: user.cookie })
  assert.equal(oldSession.status, 401)

  const newSession = await client.request('/api/auth/me', { cookie: newCookie })
  assert.equal(newSession.status, 200)
  const me = (await newSession.json()) as { user: { account: string } }
  assert.equal(me.user.account, user.account)
})

test('密码错误与账号不存在都返回同一 AUTH_FAILED', async () => {
  const user = await registerUser(client)
  const wrongPassword = await client.request('/api/auth/login', {
    method: 'POST',
    body: {
      contractVersion: '3.0',
      requestId: uuid(),
      account: user.account,
      password: 'wrong-password-123',
    },
  })
  const wrongBody = (await wrongPassword.json()) as Record<string, unknown>

  const unknownAccount = await client.request('/api/auth/login', {
    method: 'POST',
    body: {
      contractVersion: '3.0',
      requestId: uuid(),
      account: 'no_such_account_1',
      password: 'wrong-password-123',
    },
  })
  const unknownBody = (await unknownAccount.json()) as Record<string, unknown>

  assert.equal(wrongPassword.status, 401)
  assert.equal(wrongBody.code, 'AUTH_FAILED')
  assert.equal(wrongBody.message, '用户名或密码不正确')
  assert.equal(unknownAccount.status, 401)
  assert.equal(unknownBody.code, 'AUTH_FAILED')
  assert.equal(unknownBody.message, wrongBody.message)
})

test('logout 幂等：重复退出都返回 200，之后会话不可用', async () => {
  const user = await registerUser(client)
  const request = {
    contractVersion: '3.0',
    requestId: uuid(),
  }
  const first = await client.request('/api/auth/logout', {
    method: 'POST',
    cookie: user.cookie,
    body: request,
  })
  const firstBody = (await first.json()) as Record<string, unknown>
  assert.equal(first.status, 200)
  assert.equal(firstBody.loggedOut, true)
  assert.match(first.headers.get('set-cookie') ?? '', /Max-Age=0/)

  const second = await client.request('/api/auth/logout', {
    method: 'POST',
    cookie: user.cookie,
    body: { contractVersion: '3.0', requestId: uuid() },
  })
  assert.equal(second.status, 200)

  const me = await client.request('/api/auth/me', { cookie: user.cookie })
  assert.equal(me.status, 401)
})

test('会话绝对过期后返回 401 UNAUTHORIZED', async () => {
  const shortClient = await createTestClient({ sessionTtlMs: 60 })
  try {
    const user = await registerUser(shortClient)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const me = await shortClient.request('/api/auth/me', { cookie: user.cookie })
    const body = (await me.json()) as Record<string, unknown>
    assert.equal(me.status, 401)
    assert.equal(body.code, 'UNAUTHORIZED')
    assert.equal(body.message, '登录状态已失效，请重新登录')
  } finally {
    await shortClient.close()
  }
})

test('未登录访问受保护接口返回 401，未登录不是 FORBIDDEN_ORIGIN', async () => {
  const response = await client.request('/api/projects')
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(response.status, 401)
  assert.equal(body.code, 'UNAUTHORIZED')
})

test('CORS：允许来源回显精确 Origin 且 credentials=true，禁止通配符', async () => {
  const preflight = await client.request('/api/projects', {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true')
  assert.notEqual(preflight.headers.get('access-control-allow-origin'), '*')
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PATCH/)
  assert.equal(preflight.headers.get('vary'), 'Origin')
})

test('写请求缺失或非法 Origin 返回 403 FORBIDDEN_ORIGIN', async () => {
  const missing = await client.request('/api/auth/register', {
    method: 'POST',
    origin: null,
    body: registerBody(),
  })
  const missingBody = (await missing.json()) as Record<string, unknown>
  assert.equal(missing.status, 403)
  assert.equal(missingBody.code, 'FORBIDDEN_ORIGIN')
  assert.equal(missingBody.message, '请求来源不受信任')

  const denied = await client.request('/api/auth/register', {
    method: 'POST',
    origin: 'https://evil.example.com',
    body: registerBody(),
  })
  assert.equal(denied.status, 403)
  assert.equal(denied.headers.get('access-control-allow-origin'), null)

  const crossSite = await client.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site' },
    body: {
      contractVersion: '3.0',
      requestId: uuid(),
      account: 'someone',
      password: PASSWORD,
    },
  })
  assert.equal(crossSite.status, 403)
})

test('生产模式 Cookie 带 Secure；所有响应 no-store', async () => {
  const secureClient = await createTestClient({ secureCookies: true })
  try {
    const response = await secureClient.request('/api/auth/register', {
      method: 'POST',
      body: registerBody(),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie') ?? '', /Secure/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  } finally {
    await secureClient.close()
  }
})

test('日志不记录密码、邀请码、Cookie、请求路径或请求正文', async () => {
  await registerUser(client)
  await client.request('/api/auth/login', {
    method: 'POST',
    body: {
      contractVersion: '3.0',
      requestId: uuid(),
      account: 'missing_user_1',
      password: 'super-secret-password',
    },
  })

  const logs = client.logger.text()
  assert.equal(logs.includes(PASSWORD), false)
  assert.equal(logs.includes(INVITE_CODE), false)
  assert.equal(logs.includes('super-secret-password'), false)
  assert.equal(logs.includes('scp_session'), false)
  assert.equal(logs.includes('/api/'), false)
  assert.equal(logs.toLowerCase().includes('password'), false)
  assert.equal(logs.toLowerCase().includes('invitecode'), false)
})
