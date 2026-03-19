import { useCallback, useEffect, useRef, useState } from 'react';

export const WEB_API_KEY_STORAGE_KEY = 'sparky-web-access-token';
const LEGACY_WEB_API_KEY_STORAGE_KEY = 'sparky-web-api-key';

interface UseWebApiKeyOptions {
  onSaved?: () => void;
}

function readStoredToken() {
  try {
    return localStorage.getItem(WEB_API_KEY_STORAGE_KEY) || localStorage.getItem(LEGACY_WEB_API_KEY_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function useWebApiKey(options: UseWebApiKeyOptions = {}) {
  const { onSaved } = options;
  const [webApiKey, setWebApiKey] = useState<string>(() => readStoredToken());
  const [webApiKeyModalOpen, setWebApiKeyModalOpen] = useState(false);
  const [webApiKeyInput, setWebApiKeyInput] = useState('');
  const [webApiKeyMissing, setWebApiKeyMissing] = useState(false);
  const webApiKeyRef = useRef<string>(webApiKey);

  useEffect(() => {
    webApiKeyRef.current = webApiKey;
  }, [webApiKey]);

  const ensureWebApiKey = useCallback(() => {
    if (webApiKeyRef.current) return true;
    setWebApiKeyMissing(true);
    setWebApiKeyInput('');
    setWebApiKeyModalOpen(true);
    return false;
  }, []);

  const getWebApiKey = useCallback(() => {
    if (!ensureWebApiKey()) return null;
    return webApiKeyRef.current;
  }, [ensureWebApiKey]);

  const handleWebApiError = useCallback((status: number) => {
    if (status === 401 || status === 403) {
      setWebApiKeyMissing(true);
      setWebApiKeyInput(webApiKeyRef.current);
      setWebApiKeyModalOpen(true);
    }
  }, []);

  const handleSaveWebApiKey = useCallback(() => {
    const nextKey = webApiKeyInput.trim();
    setWebApiKey(nextKey);
    webApiKeyRef.current = nextKey;
    try {
      if (nextKey) {
        localStorage.setItem(WEB_API_KEY_STORAGE_KEY, nextKey);
        localStorage.removeItem(LEGACY_WEB_API_KEY_STORAGE_KEY);
      } else {
        localStorage.removeItem(WEB_API_KEY_STORAGE_KEY);
        localStorage.removeItem(LEGACY_WEB_API_KEY_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
    setWebApiKeyModalOpen(false);
    setWebApiKeyInput('');
    setWebApiKeyMissing(false);
    onSaved?.();
  }, [onSaved, webApiKeyInput]);

  return {
    webApiKey,
    webApiKeyRef,
    webApiKeyModalOpen,
    webApiKeyInput,
    webApiKeyMissing,
    setWebApiKey,
    setWebApiKeyModalOpen,
    setWebApiKeyInput,
    setWebApiKeyMissing,
    ensureWebApiKey,
    getWebApiKey,
    handleWebApiError,
    handleSaveWebApiKey,
  };
}
