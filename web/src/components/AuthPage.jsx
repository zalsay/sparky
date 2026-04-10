import { BRAND_LOGO_SRC } from '../app/constants'

export function AuthPage({
  authMode,
  authModeCopy,
  loginError,
  loggingIn,
  loginName,
  loginPassword,
  onLoginNameChange,
  onLoginPasswordChange,
  onSubmit,
  onSwitchAuthMode,
}) {
  const isRegister = authMode === 'register'

  return (
    <div className="app auth-page">
      <div className="app-aura app-aura-brand" />
      <div className="app-aura app-aura-signal" />
      <div className="auth-layout">
        <section className="auth-hero">
          <div className="brand-mark">
            <img className="brand-mark-logo" src={BRAND_LOGO_SRC} alt="Sparky" />
            <span className="brand-mark-text">Sparky</span>
          </div>
          <span className="eyebrow">AI 开发工作台</span>
          <h1 className="hero-title">一个入口，直接切到 Claude 或 Codex。</h1>
          <p className="hero-copy">
            登录后直接进入项目工作台。会话保活、项目快照和自动登录都默认接管，界面只保留项目和终端本身。
          </p>
          <div className="hero-rail">
            <div className="hero-stat">
              <span className="hero-stat-label">模型</span>
              <strong>Claude + Codex</strong>
            </div>
            <div className="hero-stat">
              <span className="hero-stat-label">状态</span>
              <strong>自动恢复登录</strong>
            </div>
            <div className="hero-stat">
              <span className="hero-stat-label">存储</span>
              <strong>项目目录快照</strong>
            </div>
          </div>
        </section>

        <form className="auth-panel" onSubmit={onSubmit}>
          <div className="panel-header">
            <span className="eyebrow">工作区访问</span>
            <h2 className="auth-title">{authModeCopy.title}</h2>
            <p className="auth-subtitle">{authModeCopy.subtitle}</p>
          </div>

          <div className="auth-switch" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              className={`auth-switch-btn ${!isRegister ? 'active' : ''}`}
              onClick={() => onSwitchAuthMode('login')}
            >
              登录
            </button>
            <button
              type="button"
              className={`auth-switch-btn ${isRegister ? 'active' : ''}`}
              onClick={() => onSwitchAuthMode('register')}
            >
              注册
            </button>
          </div>

          <label className="field-label" htmlFor="username">
            用户名
          </label>
          <input
            id="username"
            className="field-input"
            value={loginName}
            onChange={(event) => onLoginNameChange(event.target.value)}
            placeholder="例如 blue"
            autoComplete="username"
            autoFocus
          />

          <label className="field-label" htmlFor="password">
            密码
          </label>
          <input
            id="password"
            type="password"
            className="field-input"
            value={loginPassword}
            onChange={(event) => onLoginPasswordChange(event.target.value)}
            placeholder={isRegister ? '至少 8 位密码' : '输入密码'}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
          />

          {loginError ? <div className="notice notice-error">{loginError}</div> : null}

          <button className="primary-btn auth-submit" type="submit" disabled={loggingIn}>
            {authModeCopy.action}
          </button>
        </form>
      </div>
    </div>
  )
}
