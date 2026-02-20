import { useState, useEffect } from 'react';
import { ConfigProvider, theme } from 'antd';
import { ChatView } from './components/ChatView';
import { useChatStore } from './store/chatStore';

const RELAY_URL = import.meta.env.VITE_RELAY_URL || 'ws://localhost:8005';

function WebApp() {
  const [taskId] = useState(() => `task-${Date.now()}`);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const { addMessage, addPermissionRequest, updatePermissionRequest } = useChatStore();

  useEffect(() => {
    const wsUrl = `${RELAY_URL}/ws/${taskId}`;
    console.log('Connecting to:', wsUrl);

    const socket = new WebSocket(wsUrl);
    setWs(socket);

    socket.onopen = () => {
      console.log('Connected');
      addMessage({
        id: `msg-${Date.now()}`,
        role: 'system',
        content: 'Connected to relay server',
        timestamp: Date.now(),
      });
    };

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const { type, data } = payload;

        switch (type) {
          case 'log':
          case 'chat_log_stream':
            addMessage({
              id: `msg-${Date.now()}`,
              role: 'assistant',
              content: typeof data.content === 'string' ? data.content : JSON.stringify(data),
              timestamp: Date.now(),
            });
            break;
          case 'status':
            addMessage({
              id: `msg-${Date.now()}`,
              role: 'system',
              content: `Status: ${data.status}`,
              timestamp: Date.now(),
            });
            break;
          case 'permission_request':
            addPermissionRequest({
              request_id: data.request_id,
              hook_type: data.hook_type,
              raw_command: data.raw_command,
              description: data.description,
              status: 'pending',
            });
            break;
        }
      } catch (err) {
        console.error('Parse error:', err);
      }
    };

    socket.onclose = () => {
      console.log('Disconnected');
    };

    socket.onerror = (error) => {
      console.error('WS Error:', error);
    };

    return () => {
      socket.close();
    };
  }, [taskId]);

  const handleSendMessage = (content: string) => {
    // Add user message
    addMessage({
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    });

    // Send to relay
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        sender: 'web_ui',
        task_id: taskId,
        type: 'command',
        action: 'start_task',
        data: { prompt: content },
      }));
    }
  };

  const handleApprovePermission = (requestId: string) => {
    updatePermissionRequest(requestId, 'approved');
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        sender: 'web_ui',
        task_id: taskId,
        type: 'permission_response',
        data: { request_id: requestId, decision: 'approve' },
      }));
    }
  };

  const handleRejectPermission = (requestId: string) => {
    updatePermissionRequest(requestId, 'rejected');
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        sender: 'web_ui',
        task_id: taskId,
        type: 'permission_response',
        data: { request_id: requestId, decision: 'reject' },
      }));
    }
  };

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1677ff',
        },
      }}
    >
      <ChatView
        onSendMessage={handleSendMessage}
        onApprovePermission={handleApprovePermission}
        onRejectPermission={handleRejectPermission}
      />
    </ConfigProvider>
  );
}

export default WebApp;
