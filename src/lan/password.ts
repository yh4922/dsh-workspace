/*
 * @Description: 局域网访问 —— 固定密码 scrypt 哈希 / 校验、随机密码生成
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/lan/password.ts
 */
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'

const N = 16384
const R = 8
const P = 1
const KEY_LEN = 32

/** 哈希格式：scrypt$N$r$p$salt(b64)$hash(b64)。参数写进字符串，日后调参旧哈希仍可校验。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string]
  try {
    const expected = Buffer.from(hash, 'base64')
    const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** 6 位数字：手机上好输入；配合失败锁定（5 次 / 5 分钟）暴力穷举不现实。 */
export function randomPassword(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** 定长比较两个字符串（随机密码校验用，避免按位提前返回泄露时序）。 */
export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}
