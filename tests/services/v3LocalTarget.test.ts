import { describe, expect, it } from 'vitest'
import {
  assertLoopbackRequestUrl,
  isLoopbackHostname,
  resolveLocalTarget,
  rewriteRequestUrl,
} from '../support/v3LocalTarget'

const CLIENT_BASE = 'http://127.0.0.1:8080'
const LOCAL_BASE = 'http://127.0.0.1:8099'

describe('本地集成测试目标：只允许 loopback', () => {
  it('未设置时不报错，返回 unconfigured 供调用方跳过', () => {
    expect(resolveLocalTarget(undefined).state).toBe('unconfigured')
    expect(resolveLocalTarget('').state).toBe('unconfigured')
    expect(resolveLocalTarget('   ').state).toBe('unconfigured')
  })

  it('接受 localhost / 127.0.0.1 / IPv6 loopback，并去掉末尾斜杠', () => {
    const ipv4 = resolveLocalTarget('http://127.0.0.1:8099/')
    expect(ipv4).toMatchObject({ state: 'ready', baseUrl: 'http://127.0.0.1:8099' })

    const localhost = resolveLocalTarget('http://localhost:8099')
    expect(localhost).toMatchObject({
      state: 'ready',
      baseUrl: 'http://localhost:8099',
      origin: 'http://localhost:8099',
    })

    expect(resolveLocalTarget('http://[::1]:8099').state).toBe('ready')
    // 127.0.0.0/8 整段都是 loopback
    expect(resolveLocalTarget('https://127.0.0.5:8443').state).toBe('ready')
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
  })

  it('生产域名、内网地址、0.0.0.0 一律拒绝', () => {
    for (const raw of [
      'https://course.xinxian-music.xyz',
      'https://api.example.com:8099',
      'http://192.168.1.10:8099',
      'http://10.0.0.5:8099',
      'http://0.0.0.0:8099',
      'http://127.0.0.1.evil.example:8099',
    ]) {
      const resolved = resolveLocalTarget(raw)
      expect(resolved.state, raw).toBe('invalid')
    }
    expect(isLoopbackHostname('api.example.com')).toBe(false)
    expect(isLoopbackHostname('300.0.0.1')).toBe(false)
  })

  it('拒绝不支持的协议、地址里的凭据与 /api 后缀', () => {
    expect(resolveLocalTarget('ftp://127.0.0.1:8099').state).toBe('invalid')
    expect(resolveLocalTarget('file:///tmp/db.sqlite').state).toBe('invalid')
    expect(resolveLocalTarget('http://user:pass@127.0.0.1:8099').state).toBe('invalid')
    expect(resolveLocalTarget('http://127.0.0.1:8099/api').state).toBe('invalid')
    expect(resolveLocalTarget('not-a-url').state).toBe('invalid')
  })

  it('请求地址闸门在发请求前抛错，不会放过外部地址', () => {
    expect(() => assertLoopbackRequestUrl('https://course.xinxian-music.xyz/api/projects')).toThrow(
      /非 loopback/,
    )
    expect(() => assertLoopbackRequestUrl('http://192.168.1.10:8099/api/projects')).toThrow(
      /非 loopback/,
    )
    expect(() => assertLoopbackRequestUrl('ws://127.0.0.1:8099/api/projects')).toThrow(/协议/)
    expect(() => assertLoopbackRequestUrl('/api/projects')).toThrow(/绝对 URL/)
    expect(assertLoopbackRequestUrl('http://127.0.0.1:8099/api/projects').hostname).toBe(
      '127.0.0.1',
    )
  })

  it('把客户端基地址改写到本地目标，外部地址保持原样并被闸门拒绝', () => {
    expect(rewriteRequestUrl(`${CLIENT_BASE}/api/projects`, CLIENT_BASE, LOCAL_BASE)).toBe(
      `${LOCAL_BASE}/api/projects`,
    )
    expect(rewriteRequestUrl(CLIENT_BASE, CLIENT_BASE, LOCAL_BASE)).toBe(LOCAL_BASE)
    // 已经是本地目标时不重复拼接
    expect(rewriteRequestUrl(`${LOCAL_BASE}/api/projects`, CLIENT_BASE, LOCAL_BASE)).toBe(
      `${LOCAL_BASE}/api/projects`,
    )
    // 绝对的外部地址不会被改写到 loopback，而是交给闸门拒绝
    const external = 'https://course.xinxian-music.xyz/api/projects'
    const rewritten = rewriteRequestUrl(external, CLIENT_BASE, LOCAL_BASE)
    expect(rewritten).toBe(external)
    expect(() => assertLoopbackRequestUrl(rewritten)).toThrow(/非 loopback/)
  })
})
