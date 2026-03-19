import { webApi } from '../../services/webApi';
import type { LoginPayload, RefreshResponse, RegisterPayload, AuthResponse, AuthUser } from './types';

export const authService = {
  login(payload: LoginPayload) {
    return webApi.login<AuthResponse>(payload);
  },
  register(payload: RegisterPayload) {
    return webApi.register<AuthResponse>(payload);
  },
  refresh(refreshToken: string) {
    return webApi.refresh<RefreshResponse>({ refresh_token: refreshToken });
  },
  logout(refreshToken: string) {
    return webApi.logout<{ status: string }>({ refresh_token: refreshToken });
  },
  getMe() {
    return webApi.getMe<AuthUser>();
  },
};
