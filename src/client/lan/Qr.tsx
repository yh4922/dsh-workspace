/*
 * @Description: 二维码（SVG，颜色跟随主题前景色）
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/client/lan/Qr.tsx
 */
import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/** 把二维码模块矩阵转成一条 path（每个深色模块一个 1×1 方块），比逐个 rect 小得多。 */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
  return { size: n, d }
}

export function Qr(props: { text: string; size?: number }) {
  const { size, d } = useMemo(() => qrPath(props.text), [props.text])
  const margin = 2
  const box = size + margin * 2
  return (
    <svg className="dshws-lan-qr" width={props.size ?? 160} height={props.size ?? 160} viewBox={`${-margin} ${-margin} ${box} ${box}`} role="img" aria-label={props.text}>
      {/* 白底：深色主题下也要保证扫码对比度 */}
      <rect x={-margin} y={-margin} width={box} height={box} fill="#fff" />
      <path d={d} fill="#000" shapeRendering="crispEdges" />
    </svg>
  )
}
