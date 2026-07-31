import type { CSSProperties } from 'react';

export type AgentLogoType = 'pi' | 'codex';

const LOGO_SOURCES: Record<AgentLogoType, string> = {
  pi: '/pi-logo-on-dark.svg',
  codex: '/codex.webp',
};

interface AgentLogoProps {
  agentType: AgentLogoType;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export default function AgentLogo({ agentType, size = 14, className, style }: AgentLogoProps) {
  return (
    <img
      src={LOGO_SOURCES[agentType]}
      alt=""
      aria-hidden="true"
      className={`agent-logo agent-logo-${agentType}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, ...style }}
    />
  );
}
