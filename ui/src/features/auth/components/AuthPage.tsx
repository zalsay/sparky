import { App as AntApp, Button, Card, Space, Tabs, Typography } from 'antd';
import { LockOutlined, UserAddOutlined } from '@ant-design/icons';

import logo from '../../../../../logo.png';
import { useState } from 'react';
import { useAuth } from '../context';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';

interface AuthPageProps {
  mode: 'login' | 'register';
  onModeChange: (mode: 'login' | 'register') => void;
  isDarkMode: boolean;
  onThemeChange: (value: boolean) => void;
  title?: string;
  description?: string;
}

export default function AuthPage({
  mode,
  onModeChange,
  isDarkMode,
  onThemeChange,
  title = '连接你的 Sparky 工作区',
  description = '使用统一账号体系登录 Web 与桌面端，登录成功后自动恢复 Bearer 会话。',
}: AuthPageProps) {
  const { message } = AntApp.useApp();
  const { login, register } = useAuth();
  const [submitting, setSubmitting] = useState(false);

  const handleLogin = async (payload: { username: string; password: string }) => {
    setSubmitting(true);
    try {
      await login(payload);
      message.success('登录成功');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegister = async (payload: { username: string; password: string; display_name: string; email?: string }) => {
    setSubmitting(true);
    try {
      await register(payload);
      message.success('注册成功');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '注册失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`app-container ${isDarkMode ? 'dark-mode' : ''}`}>
      <header className="app-header">
        <div className="header-content" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="logo">
            <img src={logo} alt="logo" className="logo-img" />
            <h1>Sparky</h1>
          </div>
          <Button type="text" size="small" onClick={() => onThemeChange(!isDarkMode)}>
            {isDarkMode ? '浅色' : '深色'}
          </Button>
        </div>
      </header>

      <main className="app-main" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingBottom: 24 }}>
        <div style={{ width: '100%', maxWidth: 960, display: 'grid', gridTemplateColumns: 'minmax(320px, 460px) minmax(280px, 1fr)', gap: 24 }}>
          <Card className="projects-card" variant="borderless" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <Typography.Title level={2} style={{ marginTop: 0, marginBottom: 12 }}>
              {title}
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ fontSize: 15, marginBottom: 24 }}>
              {description}
            </Typography.Paragraph>
            <Space direction="vertical" size={12}>
              <div>• Web 端统一改走 `Authorization: Bearer &lt;access_token&gt;`</div>
              <div>• 会在 401 时自动尝试 refresh，失败后回到登录页</div>
              <div>• 桌面端登录后继续沿用现有本地 Tauri 业务流</div>
            </Space>
          </Card>

          <Card className="projects-card" variant="borderless">
            <Tabs
              activeKey={mode}
              onChange={(key) => onModeChange(key as 'login' | 'register')}
              items={[
                {
                  key: 'login',
                  label: (
                    <span>
                      <LockOutlined /> 登录
                    </span>
                  ),
                  children: <LoginForm loading={submitting && mode === 'login'} onSubmit={handleLogin} />,
                },
                {
                  key: 'register',
                  label: (
                    <span>
                      <UserAddOutlined /> 注册
                    </span>
                  ),
                  children: <RegisterForm loading={submitting && mode === 'register'} onSubmit={handleRegister} />,
                },
              ]}
            />
          </Card>
        </div>
      </main>
    </div>
  );
}
