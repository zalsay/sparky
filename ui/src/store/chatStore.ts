import { create } from 'zustand';
import { ChatMessage, PermissionRequest, ConnectionStatus } from '../types';

interface ChatState {
  // Messages
  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  clearMessages: () => void;
  
  // Permission requests
  permissionRequests: PermissionRequest[];
  addPermissionRequest: (request: PermissionRequest) => void;
  updatePermissionRequest: (id: string, status: PermissionRequest['status']) => void;
  
  // Connection status
  connectionStatus: ConnectionStatus;
  setConnectionStatus: (status: ConnectionStatus) => void;
  
  // Current task
  currentTaskId: string | null;
  setCurrentTaskId: (taskId: string | null) => void;
  
  // User input
  userInput: string;
  setUserInput: (input: string) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  // Messages
  messages: [],
  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === id ? { ...msg, ...updates } : msg
      ),
    })),
  clearMessages: () => set({ messages: [] }),
  
  // Permission requests
  permissionRequests: [],
  addPermissionRequest: (request) =>
    set((state) => ({
      permissionRequests: [...state.permissionRequests, request],
    })),
  updatePermissionRequest: (id, status) =>
    set((state) => ({
      permissionRequests: state.permissionRequests.map((req) =>
        req.request_id === id ? { ...req, status } : req
      ),
    })),
  
  // Connection status
  connectionStatus: 'disconnected',
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  
  // Current task
  currentTaskId: null,
  setCurrentTaskId: (taskId) => set({ currentTaskId: taskId }),
  
  // User input
  userInput: '',
  setUserInput: (input) => set({ userInput: input }),
}));
