import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Tooltip } from 'antd';

interface ContextDonutProps {
    projectPath: string;
    onClick?: () => void;
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

export default function ContextDonut({ projectPath, onClick }: ContextDonutProps) {
    const [contextData, setContextData] = useState<ContextData | null>(null);
    const [ignoredJsonl, setIgnoredJsonl] = useState<string | null>(null);

    const fetchContext = useCallback(async () => {
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

    if (!contextData) return null;

    const handleReset = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (onClick) onClick();

        // Visually clear immediately
        setContextData({ ...contextData, inputTokens: 0, outputTokens: 0, usedPercent: 0 });

        // Save current jsonl to ignore it in the future
        try {
            const currentJsonl: string = await invoke('get_latest_claude_jsonl', { project_path: projectPath });
            if (currentJsonl) {
                setIgnoredJsonl(currentJsonl);
            }
        } catch { /* silent */ }
    };

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

    return (
        <Tooltip title={tooltipContent} placement="bottomRight" color="rgba(30,41,59,0.95)">
            <div
                onClick={handleReset}
                style={{
                    position: 'relative',
                    width: 28,
                    height: 28,
                    cursor: 'pointer',
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
}
