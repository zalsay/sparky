import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { LocalWorkerStatus } from '../types';

const HEALTH_CHECK_INTERVAL = 5000;
const HEALTH_CHECK_TIMEOUT = 3000;

interface UseLocalWorkerOptions {
  enabled?: boolean;
  checkInterval?: number;
}

export function useLocalWorker(options: UseLocalWorkerOptions = {}) {
  const { enabled = true, checkInterval = HEALTH_CHECK_INTERVAL } = options;
  const [status, setStatus] = useState<LocalWorkerStatus>('checking');
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const tauriAvailable = isTauri();

  const checkHealth = useCallback(async (): Promise<boolean> => {
    if (!tauriAvailable) {
      // In web mode, try HTTP health check to local worker endpoint
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);
        
        const response = await fetch('http://localhost:9527/health', {
          method: 'GET',
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        return response.ok;
      } catch {
        return false;
      }
    }

    // In Tauri mode, use invoke to check local worker status
    try {
      const isOnline = await invoke<boolean>('check_local_worker_health');
      return isOnline;
    } catch {
      return false;
    }
  }, [tauriAvailable]);

  const performHealthCheck = useCallback(async () => {
    setStatus('checking');
    const isOnline = await checkHealth();
    setStatus(isOnline ? 'online' : 'offline');
    setLastChecked(Date.now());
  }, [checkHealth]);

  useEffect(() => {
    if (!enabled) {
      setStatus('offline');
      return;
    }

    // Initial check
    performHealthCheck();

    // Set up interval
    intervalRef.current = setInterval(performHealthCheck, checkInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, checkInterval, performHealthCheck]);

  return {
    status,
    lastChecked,
    checkHealth: performHealthCheck,
    isOnline: status === 'online',
    isChecking: status === 'checking',
  };
}
