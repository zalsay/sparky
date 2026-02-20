import React from 'react';
import { Card, Button, Tag, Space, Typography } from 'antd';
import { CheckOutlined, CloseOutlined, EditOutlined, WarningOutlined } from '@ant-design/icons';
import { PermissionRequest } from '../types';

const { Text } = Typography;

interface ActionCardProps {
  request: PermissionRequest;
  onApprove: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onEdit?: (requestId: string) => void;
}

export const ActionCard: React.FC<ActionCardProps> = ({
  request,
  onApprove,
  onReject,
  onEdit,
}) => {
  const isPending = request.status === 'pending';
  const isDangerous = ['shell', 'exec', 'sudo'].includes(request.hook_type);

  return (
    <Card
      size="small"
      className="mb-4 border-l-4 border-l-orange-500"
      styles={{ body: { padding: '12px 16px' } }}
    >
      <div className="flex items-start gap-3">
        {isDangerous && (
          <WarningOutlined className="text-orange-500 text-lg mt-1" />
        )}
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <Tag color={isDangerous ? 'orange' : 'blue'}>
              {request.hook_type}
            </Tag>
            <Text type="secondary" className="text-xs">
              {request.request_id}
            </Text>
            {request.status !== 'pending' && (
              <Tag color={request.status === 'approved' ? 'green' : 'red'}>
                {request.status === 'approved' ? 'Approved' : 'Rejected'}
              </Tag>
            )}
          </div>
          
          <div className="mb-2">
            <Text strong className="block mb-1">
              {request.description}
            </Text>
            <pre className="block p-2 bg-gray-100 rounded text-sm overflow-x-auto">
              {request.raw_command}
            </pre>
          </div>

          {isPending && (
            <Space className="mt-3">
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={() => onApprove(request.request_id)}
                className="bg-green-500 border-green-500 hover:bg-green-600"
              >
                Allow
              </Button>
              <Button
                danger
                icon={<CloseOutlined />}
                onClick={() => onReject(request.request_id)}
              >
                Reject
              </Button>
              {onEdit && (
                <Button
                  icon={<EditOutlined />}
                  onClick={() => onEdit(request.request_id)}
                >
                  Edit
                </Button>
              )}
            </Space>
          )}
        </div>
      </div>
    </Card>
  );
};
