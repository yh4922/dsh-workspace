/*
 * @Description: H5 —— 应用壳：重连细条 + hash 路由 + 切页滑动动画
 * @Author: YangHeng
 * @Date: 2026-11-19 15:25:00
 * @FilePath: /dsh-workspace/src/mobile/App.tsx
 */
import { Suspense, lazy } from 'react'
import { ReconnectBar } from './components/ReconnectBar.js'
import { Home } from './pages/Home.js'
import { formatHash, useRoute } from './router.js'

// 会话详情（P3 起含消息渲染、markdown、Composer）体积大，单独分片：首页首屏不为它买单。
const Session = lazy(() => import('./pages/Session.js').then((m) => ({ default: m.Session })))

export function App() {
  const { route, direction } = useRoute()
  return (
    <div className="m-app">
      <ReconnectBar />
      {/* key 随路由变：React 重新挂载页面节点，CSS 入场动画按方向从右 / 从左滑入。 */}
      <div key={formatHash(route)} className="m-view" data-dir={direction}>
        {route.page === 'session' ? (
          <Suspense fallback={<div className="m-page" />}>
            <Session sessionId={route.sessionId} />
          </Suspense>
        ) : (
          <Home />
        )}
      </div>
    </div>
  )
}
