/*
 * @Description: 局域网访问 —— 无依赖自签证书（node:crypto + 手写 DER）
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/lan/cert.ts
 *
 * 为什么手写 DER：Node 只能解析 X.509，不能签发；引入 node-forge / selfsigned 体积大且要随插件发布。
 * 自签证书只需要 TBSCertificate 的最小子集（版本、序列号、算法、名称、有效期、公钥、SAN），百来行即可。
 * 宿主自带的局域网 HTTPS 证书由 Electron 主进程持有，插件拿不到，所以不复用。
 */
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), len(body.length), body])
}

const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items))
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items))

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  const out: number[] = [40 * parts[0]! + parts[1]!]
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f]
    let v = p >> 7
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80)
      v >>= 7
    }
    out.push(...stack)
  }
  return tlv(0x06, Buffer.from(out))
}

function integer(bytes: Buffer): Buffer {
  // 最高位为 1 时补 0x00，保证是正数。
  return tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes)
}

function utf8(s: string): Buffer {
  return tlv(0x0c, Buffer.from(s, 'utf8'))
}

/** GeneralizedTime（2050 年以后 UTCTime 不够用，统一用 GeneralizedTime 省去分支）。 */
function time(d: Date): Buffer {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const s = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return tlv(0x18, Buffer.from(s, 'ascii'))
}

function name(cn: string): Buffer {
  return seq(set(seq(oid('2.5.4.3'), utf8(cn))), set(seq(oid('2.5.4.10'), utf8('DSH Workspace'))))
}

function ipBytes(ip: string): Buffer | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return undefined
  return Buffer.from(ip.split('.').map(Number))
}

export interface LanCertificate {
  key: string
  cert: string
  /** 签发时覆盖的地址（局域网 IP 变化后需要重签）。 */
  addresses: string[]
  fingerprint256: string
}

/** 签发一张自签服务器证书，SAN 覆盖 localhost + 给定 IPv4。有效期 825 天（苹果对自签证书的上限）。 */
export function createSelfSigned(addresses: readonly string[], now = new Date()): LanCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const sigAlg = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]))
  const notBefore = new Date(now.getTime() - 24 * 3600_000)
  const notAfter = new Date(now.getTime() + 825 * 24 * 3600_000)
  const ips = [...new Set(['127.0.0.1', ...addresses])]
  const altNames = Buffer.concat([
    tlv(0x82, Buffer.from('localhost', 'ascii')),
    ...ips.map(ipBytes).filter((b): b is Buffer => b !== undefined).map((b) => tlv(0x87, b))
  ])
  const extensions = tlv(
    0xa3,
    seq(
      seq(oid('2.5.29.17'), tlv(0x04, seq(altNames))),
      seq(oid('2.5.29.19'), tlv(0x04, seq())),
      seq(oid('2.5.29.37'), tlv(0x04, seq(oid('1.3.6.1.5.5.7.3.1'))))
    )
  )
  const serial = randomBytes(16)
  serial[0] = serial[0]! & 0x7f
  const subject = name('DSH Workspace LAN')
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    sigAlg,
    subject,
    seq(time(notBefore), time(notAfter)),
    subject,
    Buffer.from(spki),
    extensions
  )
  const signature = sign('sha256', tbs, privateKey)
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])))
  const b64 = der.toString('base64').replace(/.{64}/g, '$&\n')
  const cert = `-----BEGIN CERTIFICATE-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END CERTIFICATE-----\n`
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return { key, cert, addresses: [...addresses].sort(), fingerprint256: new X509Certificate(cert).fingerprint256 }
}

/** 读缓存证书；地址集合变了或快过期（30 天内）就重签。 */
export function loadOrCreateCertificate(dir: string, addresses: readonly string[]): LanCertificate {
  const file = path.join(dir, 'lan-cert.json')
  const wanted = [...addresses].sort()
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as Partial<LanCertificate>
      if (typeof cached.cert === 'string' && typeof cached.key === 'string' && Array.isArray(cached.addresses)) {
        const x = new X509Certificate(cached.cert)
        const fresh = new Date(x.validTo).getTime() - Date.now() > 30 * 24 * 3600_000
        if (fresh && JSON.stringify(cached.addresses) === JSON.stringify(wanted)) {
          return { key: cached.key, cert: cached.cert, addresses: wanted, fingerprint256: x.fingerprint256 }
        }
      }
    } catch {
      /* 缓存损坏：重签 */
    }
  }
  const created = createSelfSigned(wanted)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(created), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    /* Windows */
  }
  return created
}
