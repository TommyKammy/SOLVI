export interface FormFeedback {
  scopeChanged?: boolean;
  success?: string;
  postedCommentId?: string;
  postedVisibility?: 'public' | 'internal';
  message: string;
  redirectTo?: string;
  attempt?: number;
  values?: Record<string, string>;
  errors?: Array<{ field: string; message: string; label?: string }>;
}
