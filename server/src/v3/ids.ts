import { randomBytes } from 'node:crypto'

/**
 * V3 实体 ID
 * ----------------------------------------------------------------------------
 * 形态：`<prefix>_<26 位 Crockford Base32 ULID>`，与 docs/architecture/v3-v4-domain-model.md 3.1 一致。
 * 只由服务端生成；客户端传入的 ID 一律不采信。
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16

function encodeTime(now: number): string {
  let value = now
  let out = ''
  for (let index = 0; index < TIME_LEN; index += 1) {
    out = CROCKFORD[value % 32] + out
    value = Math.floor(value / 32)
  }
  return out
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN)
  let out = ''
  for (let index = 0; index < RANDOM_LEN; index += 1) {
    out += CROCKFORD[(bytes[index] ?? 0) % 32]
  }
  return out
}

export function ulid(now: number = Date.now()): string {
  return `${encodeTime(now)}${encodeRandom()}`
}

export type IdPrefix =
  | 'usr'
  | 'ses'
  | 'prj'
  | 'ms'
  | 'tsk'
  | 'evd'
  | 'mat'
  | 'seg'
  | 'cnd'
  | 'prg'
  | 'dbt'
  | 'chat'
  | 'msg'
  | 'evt'
  | 'cand'
  | 'sub'
  | 'mig'

export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${ulid(now)}`
}

/** 接受 8～64 个可打印 ASCII，且只允许字母、数字、下划线和连字符（V2 兼容 ID） */
const OPAQUE_ID = /^[A-Za-z0-9_-]{8,64}$/

export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value)
}

export function requireOpaqueId(value: unknown): string {
  if (!isOpaqueId(value)) throw new Error('invalid id')
  return value
}
