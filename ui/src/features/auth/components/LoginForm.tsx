import { Button, Form, Input, Typography } from 'antd';

import type { LoginPayload } from '../types';

interface LoginFormProps {
  loading?: boolean;
  onSubmit: (payload: LoginPayload) => Promise<void> | void;
}

export default function LoginForm({ loading = false, onSubmit }: LoginFormProps) {
  return (
    <Form<LoginPayload>
      layout="vertical"
      autoComplete="on"
      onFinish={(values) => void onSubmit(values)}
      requiredMark={false}
    >
      <Form.Item
        label="用户名"
        name="username"
        rules={[{ required: true, message: '请输入用户名' }]}
      >
        <Input placeholder="请输入用户名" autoComplete="username" size="large" />
      </Form.Item>

      <Form.Item
        label="密码"
        name="password"
        rules={[{ required: true, message: '请输入密码' }]}
      >
        <Input.Password placeholder="请输入密码" autoComplete="current-password" size="large" />
      </Form.Item>

      <Button type="primary" htmlType="submit" block size="large" loading={loading}>
        登录
      </Button>

      <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0, fontSize: 12 }}>
        登录后将自动恢复当前账号的访问令牌，并在需要时尝试刷新会话。
      </Typography.Paragraph>
    </Form>
  );
}
