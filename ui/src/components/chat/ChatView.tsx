import { useEffect, useState, useRef, useCallback } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Input, Tooltip, Button, Spin } from 'antd';
import { SendOutlined, LoadingOutlined, UserOutlined, RobotOutlined } from '@ant-design/icons';

interface ChatViewProps {
    projectPath: string;
    activeTerminalId: string | null;
}

interface ChatMessage {
    uuid: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    isToolUse?: boolean;
    toolName?: string;
    isThinking?: boolean;
}

/**
 * Parse raw JSONL entries into renderable ChatMessage objects.
 * Follows claudecodeui's parseJsonlSessions pattern for content extraction
 * and system message filtering.
 */
function parseJsonlToMessages(jsonlData: string): ChatMessage[] {
    const lines = jsonlData.split('\n').filter(line => line.trim());
    const messages: ChatMessage[] = [];

    for (const line of lines) {
        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }

        // Skip non-message entries
        if (!entry.message || !entry.message.role) continue;

        // Skip metadata-only entries
        if (entry.type === 'file-history-snapshot') continue;
        if (entry.isMeta) continue;

        const role = entry.message.role;
        const rawContent = entry.message.content;

        // Extract text content
        let textContent = '';
        if (typeof rawContent === 'string') {
            textContent = rawContent;
        } else if (Array.isArray(rawContent)) {
            const parts: string[] = [];
            for (const part of rawContent) {
                if (part.type === 'text' && part.text) {
                    parts.push(part.text);
                } else if (part.type === 'thinking' && part.thinking) {
                    // Optionally show thinking in a collapsible
                    parts.push(`<details><summary>💭 Thinking...</summary>\n\n${part.thinking}\n\n</details>`);
                } else if (part.type === 'tool_use') {
                    parts.push(`🔧 **Tool: ${part.name}**`);
                } else if (part.type === 'tool_result') {
                    // Skip tool results in main view
                    continue;
                }
            }
            textContent = parts.join('\n\n');
        }

        if (!textContent.trim()) continue;

        // Filter system messages (following claudecodeui's pattern)
        if (role === 'user') {
            const isSystemMessage =
                textContent.startsWith('<command-name>') ||
                textContent.startsWith('<command-message>') ||
                textContent.startsWith('<command-args>') ||
                textContent.startsWith('<local-command-stdout>') ||
                textContent.startsWith('<local-command-caveat>') ||
                textContent.startsWith('<system-reminder>') ||
                textContent.startsWith('Caveat:') ||
                textContent.startsWith('This session is being continued from a previous') ||
                textContent.startsWith('Invalid API key') ||
                textContent.includes('{\"subtasks\":') ||
                textContent.includes('CRITICAL: You MUST respond with ONLY a JSON') ||
                textContent === 'Warmup';

            if (isSystemMessage) continue;
        }

        // Filter assistant API error messages
        if (role === 'assistant' && entry.isApiErrorMessage === true) continue;

        messages.push({
            uuid: entry.uuid || `msg-${messages.length}`,
            role,
            content: textContent,
            timestamp: entry.timestamp || '',
            isToolUse: false,
            isThinking: false,
        });
    }

    return messages;
}

export default function ChatView({ projectPath, activeTerminalId }: ChatViewProps) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [inputValue, setInputValue] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const lastMessageCount = useRef(0);
    const isFirstLoad = useRef(true);

    const fetchMessages = useCallback(async () => {
        if (!isTauri()) {
            setLoading(false);
            setMessages([]);
            setError(null);
            return;
        }
        try {
            console.log('[ChatView] Fetching messages for projectPath:', projectPath);
            const jsonlData: string = await invoke('get_latest_claude_jsonl', { project_path: projectPath });

            if (!jsonlData) {
                console.log('[ChatView] No JSONL data returned');
                setMessages([]);
                setError(null);
                setLoading(false);
                return;
            }

            console.log('[ChatView] Got JSONL data, length:', jsonlData.length);
            const parsed = parseJsonlToMessages(jsonlData);
            console.log('[ChatView] Parsed messages count:', parsed.length);

            setMessages(parsed);
            setError(null);

            // Auto-scroll on new messages
            if (parsed.length > lastMessageCount.current || isFirstLoad.current) {
                lastMessageCount.current = parsed.length;
                isFirstLoad.current = false;
                setTimeout(() => {
                    if (scrollContainerRef.current) {
                        scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
                    }
                }, 50);
            }
        } catch (e: any) {
            console.error('[ChatView] Failed to fetch messages:', e);
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [projectPath]);

    useEffect(() => {
        isFirstLoad.current = true;
        setLoading(true);
        fetchMessages();
        const interval = setInterval(fetchMessages, 2000);
        return () => clearInterval(interval);
    }, [projectPath, fetchMessages]);

    const handleSendMessage = async () => {
        if (!inputValue.trim() || !activeTerminalId) return;
        const msg = inputValue.trim();
        setInputValue('');
        try {
            console.log('[ChatView] Sending to PTY:', activeTerminalId, msg);
            await invoke('pty_write', {
                terminal_id: activeTerminalId,
                data: msg + '\n'
            });
            // Fetch after short delay to see the new message
            setTimeout(fetchMessages, 1000);
        } catch (err) {
            console.error('[ChatView] Failed to send message to PTY:', err);
        }
    };

    if (!isTauri()) {
        return (
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                width: '100%',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--bg-primary, #0f172a)',
                color: 'var(--text-secondary, #94a3b8)',
                textAlign: 'center',
                padding: 24,
            }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>💬</div>
                <div>Chat 仅桌面端可用</div>
            </div>
        );
    }

    if (loading && messages.length === 0) {
        return (
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                width: '100%',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--bg-primary, #0f172a)',
                color: 'var(--text-secondary, #94a3b8)',
            }}>
                <Spin indicator={<LoadingOutlined style={{ fontSize: 24 }} spin />} />
                <div style={{ marginTop: 12 }}>Loading conversation...</div>
            </div>
        );
    }

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            width: '100%',
            background: 'var(--bg-primary, #0f172a)',
            overflow: 'hidden',
        }}>
            {/* Messages Area */}
            <div
                ref={scrollContainerRef}
                style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '16px',
                }}
            >
                <div style={{ maxWidth: 800, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {error && (
                        <div style={{
                            padding: '12px 16px',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            borderRadius: 8,
                            color: '#ef4444',
                            fontSize: 13,
                        }}>
                            ⚠️ Error loading messages: {error}
                        </div>
                    )}

                    {messages.length === 0 && !error && (
                        <div style={{
                            textAlign: 'center',
                            color: 'var(--text-secondary, #64748b)',
                            marginTop: 80,
                            fontSize: 14,
                        }}>
                            <div style={{ fontSize: 48, marginBottom: 16 }}>💬</div>
                            <div>No messages in this session yet.</div>
                            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
                                Start a conversation in the terminal, then switch to Chat view to see it here.
                            </div>
                        </div>
                    )}

                    {messages.map((msg) => {
                        const isUser = msg.role === 'user';

                        return (
                            <div
                                key={msg.uuid}
                                style={{
                                    display: 'flex',
                                    justifyContent: isUser ? 'flex-end' : 'flex-start',
                                    alignItems: 'flex-start',
                                    gap: 8,
                                }}
                            >
                                {/* Avatar for assistant */}
                                {!isUser && (
                                    <div style={{
                                        width: 32,
                                        height: 32,
                                        borderRadius: '50%',
                                        background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        flexShrink: 0,
                                    }}>
                                        <RobotOutlined style={{ color: '#fff', fontSize: 16 }} />
                                    </div>
                                )}

                                {/* Message bubble */}
                                <div style={{
                                    maxWidth: '85%',
                                    borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                                    padding: '10px 14px',
                                    fontSize: 14,
                                    lineHeight: 1.6,
                                    background: isUser
                                        ? 'linear-gradient(135deg, #2563eb, #3b82f6)'
                                        : 'var(--bg-secondary, #1e293b)',
                                    color: isUser ? '#fff' : 'var(--text-primary, #e2e8f0)',
                                    border: isUser ? 'none' : '1px solid var(--border-color, #334155)',
                                    wordBreak: 'break-word',
                                }}>
                                    <div className="chat-markdown-content" style={{
                                        overflow: 'hidden',
                                    }}>
                                        <ReactMarkdown
                                            remarkPlugins={[remarkGfm]}
                                            rehypePlugins={[rehypeRaw]}
                                        >
                                            {msg.content}
                                        </ReactMarkdown>
                                    </div>
                                    {msg.timestamp && (
                                        <div style={{
                                            fontSize: 11,
                                            opacity: 0.6,
                                            marginTop: 4,
                                            textAlign: isUser ? 'right' : 'left',
                                        }}>
                                            {new Date(msg.timestamp).toLocaleTimeString()}
                                        </div>
                                    )}
                                </div>

                                {/* Avatar for user */}
                                {isUser && (
                                    <div style={{
                                        width: 32,
                                        height: 32,
                                        borderRadius: '50%',
                                        background: 'linear-gradient(135deg, #2563eb, #3b82f6)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        flexShrink: 0,
                                    }}>
                                        <UserOutlined style={{ color: '#fff', fontSize: 16 }} />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Input Area */}
            <div style={{
                padding: '12px 16px',
                borderTop: '1px solid var(--border-color, #334155)',
                background: 'var(--bg-primary, #0f172a)',
                flexShrink: 0,
            }}>
                <div style={{ maxWidth: 800, margin: '0 auto', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                    <Input.TextArea
                        value={inputValue}
                        onChange={e => setInputValue(e.target.value)}
                        placeholder={activeTerminalId ? "Type a message (Enter to send, Shift+Enter for newline)..." : "No active terminal — start Claude in a terminal first"}
                        autoSize={{ minRows: 1, maxRows: 6 }}
                        disabled={!activeTerminalId}
                        onPressEnter={(e) => {
                            if (!e.shiftKey) {
                                e.preventDefault();
                                handleSendMessage();
                            }
                        }}
                        style={{
                            flex: 1,
                            background: 'var(--bg-secondary, #1e293b)',
                            color: 'var(--text-primary, #e2e8f0)',
                            borderColor: 'var(--border-color, #334155)',
                            borderRadius: 12,
                            resize: 'none',
                        }}
                    />
                    <Tooltip title="Send (Enter)">
                        <Button
                            type="primary"
                            icon={<SendOutlined />}
                            onClick={handleSendMessage}
                            disabled={!inputValue.trim() || !activeTerminalId}
                            style={{
                                height: 40,
                                width: 40,
                                borderRadius: 12,
                            }}
                        />
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}
