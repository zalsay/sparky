import { Alert, Modal } from 'antd';

interface WebApiKeyModalProps {
  open: boolean;
  value: string;
  missing: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onOk: () => void;
}

export default function WebApiKeyModal({
  open,
  onCancel,
}: WebApiKeyModalProps) {
  return (
    <Modal
      title="旧版调试入口已停用"
      open={open}
      onCancel={onCancel}
      footer={null}
    >
      <Alert
        type="info"
        showIcon
        message="Web 端已改为统一账号登录"
        description="请使用 /login 或 /register 页面获取会话。旧的手动输入 Bearer Token 调试入口已不再作为主流程。"
      />
    </Modal>
  );
}
