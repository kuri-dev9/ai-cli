import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { readGithubUsername, writeGithubUsername } from '@/shared/githubAccount';

type GitConfigResponse = {
  gitName?: string;
  gitEmail?: string;
  error?: string;
};

type SaveStatus = 'success' | 'error' | null;

export function useGitSettings() {
  const [gitName, setGitName] = useState('');
  const [gitEmail, setGitEmail] = useState('');
  // 커밋 정보와 달리 서버의 git config 가 아니라 이 앱의 preference 에 저장된다.
  const [githubUsername, setGithubUsername] = useState(readGithubUsername);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(null);
  const clearStatusTimerRef = useRef<number | null>(null);

  const loadGitConfig = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await api.user.gitConfig();
      if (!response.ok) {
        return;
      }

      const data = await response.json() as GitConfigResponse;
      setGitName(data.gitName || '');
      setGitEmail(data.gitEmail || '');
      setGithubUsername(readGithubUsername());
    } catch (error) {
      console.error('Error loading git config:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const saveGitConfig = useCallback(async () => {
    try {
      setIsSaving(true);
      const response = await api.user.updateGitConfig(gitName, gitEmail);

      if (response.ok) {
        // GitHub 사용자명은 서버가 아니라 preference 에 있으므로 따로 쓴다.
        writeGithubUsername(githubUsername);
        // 사이드바 배지가 같은 값을 보여주므로, 저장되면 다시 읽어가도록 알린다.
        window.dispatchEvent(new Event('git-config:updated'));
        setSaveStatus('success');
        clearStatusTimerRef.current = window.setTimeout(() => {
          setSaveStatus(null);
          clearStatusTimerRef.current = null;
        }, 3000);
        return;
      }

      const data = await response.json() as GitConfigResponse;
      console.error('Failed to save git config:', data.error);
      setSaveStatus('error');
    } catch (error) {
      console.error('Error saving git config:', error);
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  }, [gitEmail, gitName, githubUsername]);

  useEffect(() => {
    void loadGitConfig();
  }, [loadGitConfig]);

  useEffect(() => () => {
    if (clearStatusTimerRef.current !== null) {
      window.clearTimeout(clearStatusTimerRef.current);
    }
  }, []);

  return {
    gitName,
    setGitName,
    gitEmail,
    setGitEmail,
    githubUsername,
    setGithubUsername,
    isLoading,
    isSaving,
    saveStatus,
    saveGitConfig,
  };
}
