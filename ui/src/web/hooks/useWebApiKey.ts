import { useCallback, useMemo } from 'react';

import { useAuth } from '../../features/auth';

export const WEB_API_KEY_STORAGE_KEY = 'sparky-web-access-token';

interface UseWebApiKeyOptions {
  onSaved?: () => void;
}

export function useWebApiKey(options: UseWebApiKeyOptions = {}) {
  const { onSaved } = options;
  const { accessToken, logout } = useAuth();

  const getWebApiKey = useCallback(() => accessToken || null, [accessToken]);

  const handleWebApiError = useCallback((status: number) => {
    if (status === 401 || status === 403) {
      void logout();
    }
  }, [logout]);

  const handleSaveWebApiKey = useCallback(() => {
    onSaved?.();
  }, [onSaved]);

  return useMemo(() => ({
    webApiKey: accessToken,
    webApiKeyRef: { current: accessToken },
    webApiKeyModalOpen: false,
    webApiKeyInput: '',
    webApiKeyMissing: false,
    setWebApiKey: () => undefined,
    setWebApiKeyModalOpen: () => undefined,
    setWebApiKeyInput: () => undefined,
    setWebApiKeyMissing: () => undefined,
    ensureWebApiKey: () => Boolean(accessToken),
    getWebApiKey,
    handleWebApiError,
    handleSaveWebApiKey,
  }), [accessToken, getWebApiKey, handleSaveWebApiKey, handleWebApiError]);
}
