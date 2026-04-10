export function AuthLoadingPage() {
  return (
    <div className="app auth-page">
      <div className="app-aura app-aura-brand" />
      <div className="app-aura app-aura-signal" />
      <div className="auth-layout auth-layout-compact">
        <div className="auth-panel auth-panel-loading">
          <span className="eyebrow">Sparky</span>
          <h1 className="auth-title">检查登录状态</h1>
          <p className="auth-subtitle">正在恢复浏览器里的自动登录状态...</p>
        </div>
      </div>
    </div>
  )
}
