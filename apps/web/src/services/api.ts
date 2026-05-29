import { ProblemsResponse, Progress, ProgressPatch, Submission, SubmissionVerdict } from '../types';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

async function fetchJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === 'string' && payload.error.trim()) {
        message = payload.error;
      }
    } catch {
      const text = await response.text();
      if (text) message = text;
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export function fetchProblems(): Promise<ProblemsResponse> {
  return fetchJson<ProblemsResponse>('/api/problems');
}

export async function patchProgress(problemId: string, patch: ProgressPatch): Promise<Progress> {
  const payload = await fetchJson<{ progress: Progress }>(`/api/progress/${encodeURIComponent(problemId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return payload.progress;
}

export async function submitAnswer(problemId: string, answer: string, elapsedMs: number): Promise<Submission> {
  const payload = await fetchJson<{ submission: Submission }>(
    `/api/problems/${encodeURIComponent(problemId)}/submissions`,
    {
      method: 'POST',
      body: JSON.stringify({ answer, elapsedMs }),
    }
  );
  return payload.submission;
}

export async function patchSubmissionVerdict(
  submissionId: number,
  verdict: SubmissionVerdict
): Promise<Submission> {
  const payload = await fetchJson<{ submission: Submission }>(`/api/submissions/${submissionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ verdict }),
  });
  return payload.submission;
}
