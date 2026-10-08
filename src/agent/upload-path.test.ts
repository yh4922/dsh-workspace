/*
 * @Description: upload_to_remote 目标路径解析与受保护目标规则
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/agent/upload-path.test.ts
 */
import { describe, expect, it } from 'vitest'
import { parseUploadTarget, protectedTargetReason } from './upload-path.js'

const codeOf = (input: unknown): string | undefined => {
  try {
    parseUploadTarget(input)
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('parseUploadTarget', () => {
  it.each([
    '/etc/passwd',
    '~/x',
    '~',
    'C:\\x',
    'c:/x',
    '\\\\srv\\x',
    'a\\b',
    '../x',
    'a/../../x',
    'a/./../b',
    'a/..',
    'a\u0000b',
    'a\nb',
    '',
    '   ',
    '.',
    './',
    'a/',
    'a'.repeat(256),
    `x/${'y'.repeat(4096)}`,
    42,
    undefined
  ])('拒绝 %j', (input) => {
    expect(codeOf(input)).toBe('UPLOAD_BAD_TARGET')
  })

  it('接受相对路径，去掉 . 与空段', () => {
    expect(parseUploadTarget('logo.png')).toEqual(['logo.png'])
    expect(parseUploadTarget('public/img/logo.png')).toEqual(['public', 'img', 'logo.png'])
    expect(parseUploadTarget('./a.txt')).toEqual(['a.txt'])
    expect(parseUploadTarget('a//b/./c.txt')).toEqual(['a', 'b', 'c.txt'])
    expect(parseUploadTarget('  图片/封面 1.png  ')).toEqual(['图片', '封面 1.png'])
    expect(parseUploadTarget('..hidden')).toEqual(['..hidden'])
  })
})

describe('parseUploadTarget：伪装字符与目录写法', () => {
  it.each(['a\u202Egnp.exe', 'a\u200Bb', 'a\u0085b', 'a\uFEFFb', 'a\u2066b', 'a/.', 'dir/sub/.'])('拒绝 %j', (input) => {
    expect(codeOf(input)).toBe('UPLOAD_BAD_TARGET')
  })
})

describe('protectedTargetReason', () => {
  it('任意层级的 .git / .ssh / .husky 与 authorized_keys / .envrc 受保护', () => {
    expect(protectedTargetReason(['.git', 'hooks', 'pre-commit'])).toBeDefined()
    expect(protectedTargetReason(['sub', '.git', 'config'])).toBeDefined()
    expect(protectedTargetReason(['.GIT', 'config'])).toBeDefined()
    expect(protectedTargetReason(['.ssh', 'id_rsa'])).toBeDefined()
    expect(protectedTargetReason(['x', 'authorized_keys'])).toBeDefined()
    expect(protectedTargetReason(['.git'])).toBeDefined()
    expect(protectedTargetReason(['.husky', 'pre-commit'])).toBeDefined()
    expect(protectedTargetReason(['sub', '.envrc'])).toBeDefined()
  })

  it('普通路径与 .gitignore 不受影响', () => {
    expect(protectedTargetReason(['.gitignore'])).toBeUndefined()
    expect(protectedTargetReason(['src', '.env.example'])).toBeUndefined()
    expect(protectedTargetReason(['.bashrc'])).toBeUndefined()
  })

  const at = (realRoot: string, realTarget: string, home = '/home/dev') => protectedTargetReason(realTarget.split('/').slice(-1), { realRoot, realTarget, home })

  it('家目录下紧接的点文件 / 点目录受保护：根是家目录本身或它的上级（/home、/）都拦得住', () => {
    expect(at('/home/dev', '/home/dev/.bashrc')).toBeDefined()
    expect(at('/home/dev', '/home/dev/.config/autostart/x.desktop')).toBeDefined()
    expect(at('/home', '/home/dev/.bashrc')).toBeDefined()
    expect(at('/', '/home/dev/.config/autostart/x.desktop')).toBeDefined()
    expect(at('/', '/.profile', '/')).toBeDefined()
  })

  it('家目录下的普通目录、家目录外、以及根设在点目录里的工作区不受影响', () => {
    expect(at('/home/dev', '/home/dev/proj/.env')).toBeUndefined()
    expect(at('/home', '/home/other/.bashrc')).toBeUndefined()
    expect(at('/srv/app', '/srv/app/.env')).toBeUndefined()
    // 用户把工作区根设在 ~/.dotfiles：是有意在那里工作
    expect(at('/home/dev/.dotfiles', '/home/dev/.dotfiles/zshrc')).toBeUndefined()
    // 取不到家目录：不做这条判断
    expect(protectedTargetReason(['.bashrc'], { realRoot: '/home/dev', realTarget: '/home/dev/.bashrc', home: undefined })).toBeUndefined()
  })
})
