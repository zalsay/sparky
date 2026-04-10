import { useEffect, useState } from 'react'
import {
  API_BASE,
  AUTH_STORAGE_KEY,
  LEGACY_AUTH_STORAGE_KEY,
} from '../constants'
import { clearStorage, readStorage } from '../storage'

export function useAuthController() {
  const [authReady, setAuthReady] = useState(false)
  const [auth, setAuth] = useState(null)
  const [authMode, setAuthMode] = useState('login')
  const [loginName, setLoginName] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)

  const saveAuth = (value) => {
    if (value) {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value))
      localStorage.removeItem(LEGACY_AUTH_STORAGE_KEY)
      setAuth(value)
      return
    }

    clearStorage(AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY)
    setAuth(null)
  }

  const clearAuth = () => {
    saveAuth(null)
  }

  const authHeaders = (extra = {}) => {
    if (!auth?.token) {
      return extra
    }

    return {
      ...extra,
      Authorization: `Bearer ${auth.token}`,
    }
  }

  useEffect(() => {
    const raw = readStorage(AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY)
    if (!raw) {
      setAuthReady(true)
      return
    }

    let stored = null
    try {
      stored = JSON.parse(raw)
    } catch {
      clearStorage(AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY)
      setAuthReady(true)
      return
    }

    if (!stored?.token) {
      clearStorage(AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY)
      setAuthReady(true)
      return
    }

    fetch(`${API_BASE}/auth/me`, {
      headers: {
        Authorization: `Bearer ${stored.token}`,
      },
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok || !data?.user) {
          throw new Error(data.error || '登录校验失败')
        }

        saveAuth({
          token: stored.token,
          user: data.user,
        })
      })
      .catch(() => {
        clearStorage(AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY)
      })
      .finally(() => {
        setAuthReady(true)
      })
  }, [])

  const submitAuth = async (event) => {
    event.preventDefault()
    const username = loginName.trim()
    const password = loginPassword

    if (!username) {
      setLoginError('请输入用户名')
      return
    }

    if (!password) {
      setLoginError('请输入密码')
      return
    }

    if (authMode === 'register' && password.length < 8) {
      setLoginError('密码至少需要 8 位')
      return
    }

    setLoggingIn(true)
    setLoginError('')

    try {
      const response = await fetch(`${API_BASE}/auth/${authMode}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.token || !data?.user) {
        throw new Error(data.error || `${authMode} failed`)
      }

      saveAuth({
        token: data.token,
        user: data.user,
      })
      setLoginPassword('')
    } catch (error) {
      setLoginError(error.message || (authMode === 'login' ? '登录失败' : '注册失败'))
    } finally {
      setLoggingIn(false)
    }
  }

  const switchAuthMode = (mode) => {
    setAuthMode(mode)
    setLoginError('')
    setLoginPassword('')
  }

  const authModeCopy = authMode === 'register'
    ? {
        title: '创建工作区账号',
        subtitle: '首次使用请先注册。注册成功后会直接登录，并在刷新后自动恢复到工作台。',
        action: loggingIn ? '注册中...' : '注册并登录',
      }
    : {
        title: '进入工作区',
        subtitle: '使用用户名和密码登录。浏览器会保留 token，后续刷新自动恢复登录。',
        action: loggingIn ? '登录中...' : '登录',
      }

  return {
    auth,
    authHeaders,
    authMode,
    authModeCopy,
    authReady,
    clearAuth,
    loginError,
    loggingIn,
    loginName,
    loginPassword,
    saveAuth,
    setLoginError,
    setLoginName,
    setLoginPassword,
    submitAuth,
    switchAuthMode,
  }
}
