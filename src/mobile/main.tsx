/*
 * @Description: H5 —— 入口（自带 React，不依赖宿主外壳注入）
 * @Author: YangHeng
 * @Date: 2026-11-19 15:28:00
 * @FilePath: /dsh-workspace/src/mobile/main.tsx
 *
 * 样式不在这里 import：rolldown 不打包 CSS，theme.css 由 scripts/build-mobile.mjs 加 hash 后以 <link> 写进 index.html。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { VERSION } from '../client/build-info.js'
import { App } from './App.js'

const el = document.getElementById('root')
if (el !== null) {
  el.dataset.version = VERSION
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
