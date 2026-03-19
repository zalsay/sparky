import { ApiOutlined } from '@ant-design/icons';
import { Input, Modal } from 'antd';

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
  value,
  missing,
  onChange,
  onCancel,
  onOk,
}: WebApiKeyModalProps) {
  return (
    <Modal
      title={(
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ApiOutlined style={{ color: '#1677ff', fontSize: '18px' }} />
          <span>输入 Web 访问令牌</span>
        </div>
      )}
      open={open}
      onCancel={onCancel}
      okText="保存"
      cancelText="取消"
      onOk={onOk}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input
          placeholder="请输入 Bearer Token"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPressEnter={onOk}
        />
        {missing && (
          <div style={{ fontSize: 12, color: '#faad14' }}>
            访问令牌缺失或无权限，请重新输入。
          </div>
        )}
      </div>
    </Modal>
  );
}
