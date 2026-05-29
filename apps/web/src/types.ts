export interface Progress {
  opened: boolean;
  starred: boolean;
  note: string;
  updatedAt: string | null;
}

export interface Problem {
  id: string;
  index: number;
  name: string;
  tags: string[];
  statement: string;
  hint: string;
  solution: string;
  progress: Progress;
  submissions: Submission[];
}

export interface ProblemsResponse {
  problems: Problem[];
}

export type ProgressPatch = Partial<Pick<Progress, 'opened' | 'starred' | 'note'>>;

export interface Submission {
  id: number;
  problemId: string;
  answer: string;
  elapsedMs: number;
  isCorrect: boolean | null;
  feedback: string;
  createdAt: string;
  updatedAt: string;
}
