import { useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '../store/chatStore';
import { MessagePayload } from '../types';

const RECONNECT_INTERVAL = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;

interface UseWebSocketOptions {
  url: string;
  taskId: string;
}

export function useWebSocket({ url, taskId }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const {
    setConnectionStatus,
    addMessage,
    addPermissionRequest,
    updatePermissionRequest,
  } = useChatStore();

  const connect = useCallback(() => {
    if (!taskId) return;

    const wsUrl = `${url}/ws/${taskId}`;
    console.log('Connecting to:', wsUrl);

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      setConnectionStatus('connecting');

      ws.onopen = () => {
        console.log('WebSocket connected');
        setConnectionStatus('connected');
        reconnectAttempts.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const payload: MessagePayload = JSON.parse(event.data);
          handleMessage(payload);
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected');
        setConnectionStatus('disconnected');
        attemptReconnect();
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setConnectionStatus('error');
      };
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      setConnectionStatus('error');
    }
  }, [url, taskId, setConnectionStatus]);

  const handleMessage = useCallback((payload: MessagePayload) => {
    const { type, data } = payload;

    switch (type) {
      case 'log':
      case 'chat_log_stream':
        // Aggregate logs into assistant messages
        const stepId = data.step_id as string || `step-${Date.now()}`;
        addMessage({
          id: `msg-${Date.now()}-${Math.random()}`,
          role: 'assistant',
          content: (data.content as string) || JSON.stringify(data),
          timestamp: Date.now(),
          stepId,
          isStreaming: true,
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
          request_id: data.request_id as string,
          hook_type: data.hook_type as string,
          raw_command: data.raw_command as string,
          description: data.description as string,
          status: 'pending',
        });
        break;

      case 'permission_response':
        const requestId = data.request_id as string;
        updatePermissionRequest(requestId, data.decision === 'approve' ? 'approved' : 'rejected');
        addMessage({
          id: `msg-${Date.now()}`,
          role: 'system',
          content: `Permission ${data.decision}: ${data.request_id}`,
          timestamp: Date.now(),
        });
        break;

      default:
        console.log('Unknown message type:', type);
    }
  }, [addMessage, addPermissionRequest, updatePermissionRequest]);

  const attemptReconnect = useCallback(() => {
    if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
      console.log('Max reconnect attempts reached');
      return;
    }

    reconnectAttempts.current++;
    console.log(`Reconnecting... attempt ${reconnectAttempts.current}`);

    reconnectTimeoutRef.current = setTimeout(() => {
      connect();
    }, RECONNECT_INTERVAL);
  }, [connect]);

  const sendMessage = useCallback((message: Partial<MessagePayload>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const payload: MessagePayload = {
        sender: 'web_ui',
        task_id: taskId,
        type: message.type || 'command',
        action: message.action,
        data: message.data || {},
      };
      wsRef.current.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, [taskId]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionStatus('disconnected');
  }, [setConnectionStatus]);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    sendMessage,
    disconnect,
    reconnect: connect,
  };
}
