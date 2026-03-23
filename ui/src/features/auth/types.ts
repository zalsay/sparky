export interface AuthUser {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
}

export interface AuthResponse {
  user: AuthUser;
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface RefreshResponse {
  access_token: string;
  expires_in: number;
}

export interface LoginPayload {
  username: string;
  password: string;
}

export interface RegisterPayload {
  username: string;
  password: string;
  display_name: string;
  email?: string;
}

export interface StoredAuthSession {
  user: AuthUser | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}
