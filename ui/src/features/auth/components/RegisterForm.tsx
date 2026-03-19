import { Button, Form, Input, Typography } from 'antd';

import type { RegisterPayload } from '../types';

interface RegisterFormProps {
  loading?: boolean;
  onSubmit: (payload: RegisterPayload) => Promise<void> | void;
}

interface RegisterFormValues extends RegisterPayload {
  confirmPassword: string;
}

export default function RegisterForm({ loading = false, onSubmit }: RegisterFormProps) {
  return (
    <Form<RegisterFormValues>
      layout="vertical"
      autoComplete="on"
      onFinish={(values) => {
        void onSubmit({
          username: values.username,
          password: values.password,
          display_name: values.display_name,
          email: values.email?.trim() || undefined,
        });
      }}      requiredMark={false}
    >
      <Form.Item
        label="用户名"
        name="username"
        rules={[
          { required: true, message: '请输入用户名' },
          { min: 3, message: '用户名至少 3 个字符' },
        ]}
      >
        <Input placeholder="请输入用户名" autoComplete="username" size="large" />
      </Form.Item>

      <Form.Item
        label="显示名称"
        name="display_name"
        rules={[{ required: true, message: '请输入显示名称' }]}
      >
        <Input placeholder="请输入显示名称" autoComplete="name" size="large" />
      </Form.Item>

      <Form.Item
        label="邮箱（可选）"
        name="email"
        rules={[{ type: 'email', message: '请输入合法邮箱地址' }]}
      >
        <Input placeholder="请输入邮箱" autoComplete="email" size="large" />
      </Form.Item>

      <Form.Item
        label="密码"
        name="password"
        rules={[
          { required: true, message: '请输入密码' },
          { min: 6, message: '密码至少 6 个字符' },
        ]}
      >
        <Input.Password placeholder="请输入密码" autoComplete="new-password" size="large" />
      </Form.Item>

      <Form.Item
        label="确认密码"
        name="confirmPassword"
        dependencies={['password']}
        rules={[
          { required: true, message: '请再次输入密码' },
          ({ getFieldValue }) => ({
            validator(_, value) {
              if (!value || getFieldValue('password') === value) {
                return Promise.resolve();
              }
              return Promise.reject(new Error('两次输入的密码不一致'));
            },
          }),
        ]}
      >
        <Input.Password placeholder="请再次输入密码" autoComplete="new-password" size="large" />
      </Form.Item>

      <Button type="primary" htmlType="submit" block size="large" loading={loading}>
        注册并登录
      </Button>

      <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0, fontSize: 12 }}>
        注册成功后会直接进入已登录态，无需再次手动输入令牌。
      </Typography.Paragraph>
    </Form>
  );
}
