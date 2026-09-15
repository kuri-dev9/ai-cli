import { EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { LLMProviderLogo, PillBar, Pill } from '@/shared/ui';
import type { AgentContextByProvider, AgentProvider } from '@/shared/types';

type AgentSelectorSectionProps = {
  agents: AgentProvider[];
  /** 설정에서 꺼 둔 CLI. 목록에는 남기고 흐리게만 그린다. */
  disabledAgents: AgentProvider[];
  selectedAgent: AgentProvider;
  onSelectAgent: (agent: AgentProvider) => void;
  agentContextById: AgentContextByProvider;
};

const AGENT_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Rendered by AgentsSettingsTab to pick which agent provider the tab is configuring. */
export default function AgentSelectorSection({
  agents,
  disabledAgents,
  selectedAgent,
  onSelectAgent,
  agentContextById,
}: AgentSelectorSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="flex-shrink-0 border-b border-border px-3 py-2 md:px-4 md:py-3">
      <PillBar className="w-full md:w-auto">
        {agents.map((agent) => {
          const dotColor =
            agent === 'claude' ? 'bg-blue-500' :
            agent === 'cursor' ? 'bg-purple-500' :
            agent === 'opencode' ? 'bg-zinc-500' : 'bg-foreground/60';
          const isDisabled = disabledAgents.includes(agent);

          return (
            <Pill
              key={agent}
              isActive={selectedAgent === agent}
              onClick={() => onSelectAgent(agent)}
              // 누를 수는 있어야 한다 — 다시 켜는 토글이 이 CLI 의 계정 화면에 있다.
              className="min-w-0 flex-1 justify-center md:flex-initial"
              title={isDisabled ? t('agents.visibility.disabledBadge') : undefined}
            >
              <LLMProviderLogo
                provider={agent}
                className={`h-4 w-4 flex-shrink-0 ${isDisabled ? 'opacity-40 grayscale' : ''}`}
              />
              <span className={`truncate ${isDisabled ? 'text-muted-foreground/60 line-through' : ''}`}>
                {AGENT_NAMES[agent]}
              </span>
              {isDisabled ? (
                <EyeOff className="h-3 w-3 flex-shrink-0 text-muted-foreground/60" />
              ) : agentContextById[agent].authStatus.authenticated && (
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotColor}`} />
              )}
            </Pill>
          );
        })}
      </PillBar>
    </div>
  );
}
