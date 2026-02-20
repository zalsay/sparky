import React, { useRef, useEffect } from 'react';
import { Badge, Tooltip } from 'antd';
import { WifiOutlined, DisconnectOutlined } from '@ant-design/icons';
import { useChatStore } from '../store/chatStore';
import { MessageBubble } from './MessageBubble';
import { ActionCard } from './ActionCard';
import { UserInput } from './UserInput';
import { ConnectionStatus } from '../types';

interface ChatViewProps {
  onSendMessage: (content: string) => void;
  onApprovePermission: (requestId: string) => void;
  onRejectPermission: (requestId: string) => void;
}

export const ChatView: React.FC<ChatViewProps> = ({
  onSendMessage,
  onApprovePermission,
  onRejectPermission,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const {
    messages,
    permissionRequests,
    connectionStatus,
  } = useChatStore();

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, permissionRequests]);

  const getStatusBadge = () => {
    const config: Record<ConnectionStatus, { status: 'success' | 'processing' | 'error' | 'default'; text: string }> = {
      connected: { status: 'success', text: 'Connected' },
      connecting: { status: 'processing', text: 'Connecting...' },
      disconnected: { status: 'default', text: 'Disconnected' },
      error: { status: 'error', text: 'Error' },
    };
    return config[connectionStatus];
  };

  const pendingRequests = permissionRequests.filter((r) => r.status === 'pending');

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sparky Chat</h1>
        <Tooltip title={getStatusBadge().text}>
          <Badge
            status={getStatusBadge().status}
            text={
              <span className="flex items-center gap-1">
                {connectionStatus === 'connected' ? (
                  <WifiOutlined className="text-green-500" />
                ) : (
                  <DisconnectOutlined className="text-gray-400" />
                )}
                {getStatusBadge().text}
              </span>
            }
          />
        </Tooltip>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            <div className="text-center">
              <p className="text-lg mb-2">Welcome to Sparky!</p>
              <p className="text-sm">
                输入你的需求，开始与 AI 助手对话
              </p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </>
        )}

        {/* Permission Requests */}
        {pendingRequests.map((req) => (
          <ActionCard
            key={req.request_id}
            request={req}
            onApprove={onApprovePermission}
            onReject={onRejectPermission}
          />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <UserInput
        onSubmit={onSendMessage}
        disabled={connectionStatus !== 'connected'}
        isRunning={pendingRequests.length > 0}
      />
    </div>
  );
};
