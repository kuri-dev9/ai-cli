import { Github } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useGitIdentity } from '@/modules/sidebar/hooks/useGitIdentity';

/**
 * SidebarHeader 가 로고 아래에 그리는 배지.
 *
 * 원래 이 자리에는 원본 프로젝트의 GitHub star 수가 붙어 있었다. 이 설치본에는
 * 남의 저장소 홍보가 필요 없으므로, 대신 설정 > Git 에 저장된 사용자 이름을
 * 보여주고 그 사람의 GitHub 프로필로 보낸다.
 *
 * 값은 온보딩에서 처음 입력하고 설정 > Git 에서 고친다. 여기서는 읽기만 한다.
 */
export default function GitIdentityBadge() {
  const { t } = useTranslation('sidebar');
  const { name, profileUrl } = useGitIdentity();

  // 아직 git 이름을 설정하지 않았으면 자리를 비워둔다. 여기서 설정으로 유도하면
  // 로고 바로 아래에 안내가 상주하게 되어 오히려 거슬린다.
  if (!name) {
    return null;
  }

  const content = (
    <>
      <Github className="h-3 w-3 flex-shrink-0" />
      <span className="truncate">{name}</span>
    </>
  );

  const shared =
    'mt-2 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground';

  // 이름이 GitHub 사용자명 형식이 아니면(예: "홍길동") 링크를 걸지 않는다.
  if (!profileUrl) {
    return (
      <div className={shared} title={name}>
        {content}
      </div>
    );
  }

  return (
    <a
      href={profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={t('identity.openProfile', { name, defaultValue: `${name} 프로필 열기` })}
      className={`${shared} transition-colors hover:border-border hover:bg-accent/50 hover:text-foreground`}
    >
      {content}
    </a>
  );
}
