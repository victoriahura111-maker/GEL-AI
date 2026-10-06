export interface UserProfile {
  id: string;
  email: string | null;
  full_name: string | null;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface MeResponse {
  user: {
    id: string;
    email: string | null;
  };
  profile: UserProfile;
}

export interface UpdateProfilePayload {
  full_name?: string;
  timezone?: string;
}
