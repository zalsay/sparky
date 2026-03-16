import { useEffect, useState, useCallback } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Tooltip, Popover, Button } from 'antd';
import { WarningOutlined } from '@ant-design/icons';

interface ContextDonutProps {
    projectPath: string;
}

interface ContextData {
    modelName: string;
    inputTokens: number;
    outputTokens: number;
    maxTokens: number;
    usedPercent: number;
}

function getMaxTokens(model: string): number {
    if (model.includes('opus')) return 200000;
    if (model.includes('sonnet')) return 200000;
    if (model.includes('haiku')) return 200000;
    return 200000;
}

function formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

function parseContextFromJsonl(jsonlData: string): ContextData | null {
    const lines = jsonlData.split('\n').filter(l => l.trim());

    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const entry = JSON.parse(lines[i]);
            if (
                entry.type === 'assistant' &&
                entry.message?.role === 'assistant' &&
                entry.message?.usage?.input_tokens > 0
            ) {
                const model = entry.message.model || 'unknown';
                const inputTokens = entry.message.usage.input_tokens;
                const outputTokens = entry.message.usage.output_tokens || 0;
                const maxTokens = getMaxTokens(model);
                const usedPercent = Math.min((inputTokens / maxTokens) * 100, 100);

                return { modelName: model, inputTokens, outputTokens, maxTokens, usedPercent };
            }
        } catch {
            continue;
        }
    }
    return null;
}

export default function ContextDonut({ projectPath }: ContextDonutProps) {
    const [contextData, setContextData] = useState<ContextData | null>(null);
    const [ignoredJsonl, setIgnoredJsonl] = useState<string | null>(null);
    const [warningClosed, setWarningClosed] = useState(false);

    const fetchContext = useCallback(async () => {
        if (!isTauri()) {
            setContextData(null);
            return;
        }
        try {
            const jsonlData: string = await invoke('get_latest_claude_jsonl', { project_path: projectPath });
            if (jsonlData) {
                if (jsonlData !== ignoredJsonl) {
                    setContextData(parseContextFromJsonl(jsonlData));
                }
            } else {
                setContextData(null);
            }
        } catch { /* silent */ }
    }, [projectPath, ignoredJsonl]);

    useEffect(() => {
        fetchContext();
        const interval = setInterval(fetchContext, 3000);
        return () => clearInterval(interval);
    }, [fetchContext]);

    useEffect(() => {
        const onResetEvent = (e: CustomEvent<string>) => {
            if (e.detail === projectPath) {
                // Visually clear immediately
                setContextData(prev => prev ? { ...prev, inputTokens: 0, outputTokens: 0, usedPercent: 0 } : null);
                // Reset warning state
                setWarningClosed(false);

                // Save current jsonl to ignore it in the future
                invoke('get_latest_claude_jsonl', { project_path: projectPath }).then((currentJsonl: unknown) => {
                    if (currentJsonl && typeof currentJsonl === 'string') {
                        setIgnoredJsonl(currentJsonl);
                    }
                }).catch(() => { });
            }
        };

        window.addEventListener('claude-context-reset', onResetEvent as EventListener);
        return () => {
            window.removeEventListener('claude-context-reset', onResetEvent as EventListener);
        };
    }, [projectPath]);

    if (!isTauri()) {
        return (
            <div style={{
                padding: '6px 10px',
                background: 'rgba(0, 0, 0, 0.2)',
                borderRadius: 6,
                color: 'var(--text-secondary, #94a3b8)',
                fontSize: 12,
            }}>
                上下文仅桌面端可用
            </div>
        );
    }

    if (!contextData) return null;

    const { inputTokens, maxTokens, usedPercent, modelName } = contextData;

    // SVG Donut — small, matching toolbar button size (~28px)
    const size = 26;
    const strokeWidth = 3.5;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const usedDash = (usedPercent / 100) * circumference;
    const freeDash = circumference - usedDash;

    let ringColor = '#22c55e';
    if (usedPercent > 60) ringColor = '#f59e0b';
    if (usedPercent > 80) ringColor = '#ef4444';

    const tooltipContent = (
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>上下文使用情况</div>
            <div>已用: <span style={{ color: ringColor, fontWeight: 600 }}>{formatTokens(inputTokens)}</span> / {formatTokens(maxTokens)} tokens</div>
            <div>剩余: {formatTokens(maxTokens - inputTokens)} tokens ({(100 - usedPercent).toFixed(1)}%)</div>
            <div style={{ opacity: 0.7, marginTop: 2 }}>{modelName}</div>
        </div>
    );

    const donut = (
        <Tooltip title={tooltipContent} placement="bottomRight" color="rgba(30,41,59,0.95)">
            <div
                style={{
                    position: 'relative',
                    width: 28,
                    height: 28,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 6,
                    background: 'rgba(0, 0, 0, 0.2)',
                }}
            >
                <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                    <circle
                        cx={size / 2} cy={size / 2} r={radius}
                        fill="none"
                        stroke="rgba(255,255,255,0.1)"
                        strokeWidth={strokeWidth}
                    />
                    <circle
                        cx={size / 2} cy={size / 2} r={radius}
                        fill="none"
                        stroke={ringColor}
                        strokeWidth={strokeWidth}
                        strokeDasharray={`${usedDash} ${freeDash}`}
                        strokeDashoffset={circumference / 4}
                        strokeLinecap="round"
                        style={{ transition: 'stroke-dasharray 0.6s ease, stroke 0.4s ease' }}
                    />
                </svg>
                <div style={{
                    position: 'absolute',
                    fontSize: 8,
                    fontWeight: 700,
                    color: ringColor,
                    fontFamily: 'Menlo, monospace',
                }}>
                    {Math.round(usedPercent)}
                </div>
            </div>
        </Tooltip>
    );

    const showWarning = usedPercent >= 80 && !warningClosed;

    return showWarning ? (
        <Popover
            content={
                <div style={{ maxWidth: 200 }}>
                    <div style={{ marginBottom: 8, fontWeight: 600 }}>
                        <WarningOutlined style={{ color: '#faad14', marginRight: 8 }} />
                        上下文即将耗尽
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 12 }}>
                        当前上下文使用已超过 80%，建议尽早清理或精简上下文以保持良好性能。
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                        <Button size="small" onClick={() => setWarningClosed(true)}>
                            忽略
                        </Button>
                        <Button
                            size="small"
                            type="primary"
                            onClick={() => {
                                setWarningClosed(true);
                                // Trigger the compact command through the existing event mechanism
                                // App.tsx would need to handle this properly, but since the requirement 
                                // didn't ask to actually compact here, we just provide the hint.
                            }}
                        >
                            知道了
                        </Button>
                    </div>
                </div>
            }
            placement="bottomRight"
            open={showWarning}
            trigger="click"
            onOpenChange={(open) => {
                if (!open) setWarningClosed(true);
            }}
        >
            {donut}
        </Popover>
    ) : donut;
}
