import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Check,
  CheckCircle2,
  CircleHelp,
  Eye,
  EyeOff,
  Filter,
  History,
  Lightbulb,
  Lock,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Orbit,
  Star,
  Tag,
  Timer,
  X,
} from 'lucide-react';
import { MarkdownContent } from './components/MarkdownContent';
import { fetchProblems, patchProgress, patchSubmissionCorrectness, submitAnswer } from './services/api';
import { Problem, ProgressPatch, Submission } from './types';

type AppView = 'library' | 'detail';
type ResultFilter = 'all' | 'correct' | 'wrong' | 'unknown';
type ResultState = Exclude<ResultFilter, 'all'>;

const RESULT_OPTIONS: Array<{ id: ResultFilter; title: string }> = [
  { id: 'all', title: 'All problems' },
  { id: 'correct', title: 'Latest submission correct' },
  { id: 'wrong', title: 'Latest submission wrong' },
  { id: 'unknown', title: 'No submission or latest submission unknown' },
];

function latestSubmission(problem: Problem) {
  return problem.submissions?.[0] ?? null;
}

function resultState(problem: Problem): ResultState {
  const submission = latestSubmission(problem);
  if (submission?.isCorrect === true) return 'correct';
  if (submission?.isCorrect === false) return 'wrong';
  return 'unknown';
}

function resultTitle(problem: Problem) {
  const state = resultState(problem);
  const submission = latestSubmission(problem);
  if (!submission) return 'No submission';
  if (state === 'correct') return 'Latest submission correct';
  if (state === 'wrong') return 'Latest submission wrong';
  return 'Latest submission unknown';
}

function ResultPill({ state, title }: { state: ResultState; title?: string }) {
  const styles = {
    correct: 'border-emerald-200 bg-emerald-50 text-emerald-600',
    wrong: 'border-red-200 bg-red-50 text-red-600',
    unknown: 'border-violet-200 bg-violet-50 text-violet-600',
  }[state];
  const icon = {
    correct: <Check size={14} strokeWidth={2.6} />,
    wrong: <X size={14} strokeWidth={2.6} />,
    unknown: <CircleHelp size={14} strokeWidth={2.3} />,
  }[state];

  return (
    <span
      title={title}
      className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full border px-1.5 ${styles}`}
    >
      {icon}
    </span>
  );
}

function formatUpdatedAt(value: string | null) {
  if (!value) return 'Not saved';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saved';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function readRoute(): { view: AppView; id: string | null } {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('problem/')) {
    const id = decodeURIComponent(hash.slice('problem/'.length));
    return { view: 'detail', id: id || null };
  }
  return { view: 'library', id: null };
}

function writeRoute(view: AppView, id?: string | null) {
  const nextHash = view === 'detail' && id ? `#/problem/${encodeURIComponent(id)}` : '#/';
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
}

function TagPill({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-cyan-100 bg-white/80 px-2.5 py-1 text-xs font-medium text-violet-600">
      <Tag size={12} />
      {children}
    </span>
  );
}

function App() {
  const [problems, setProblems] = useState<Problem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => readRoute().id);
  const [view, setView] = useState<AppView>(() => readRoute().view);
  const [query, setQuery] = useState('');
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [starredOnly, setStarredOnly] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});
  const [submittingIds, setSubmittingIds] = useState<Record<string, boolean>>({});
  const [savingSubmissionIds, setSavingSubmissionIds] = useState<Record<number, boolean>>({});
  const noteTimersRef = useRef<Record<string, number>>({});

  const loadProblems = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const payload = await fetchProblems();
      setProblems(payload.problems);
      setSelectedId((current) => current ?? payload.problems[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProblems();
  }, [loadProblems]);

  useEffect(() => {
    const onHashChange = () => {
      const route = readRoute();
      setView(route.view);
      if (route.id) setSelectedId(route.id);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(noteTimersRef.current)) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const problem of problems) {
      for (const tag of problem.tags) tags.add(tag);
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [problems]);

  const filteredProblems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return problems.filter((problem) => {
      if (resultFilter !== 'all' && resultState(problem) !== resultFilter) return false;
      if (tagFilter !== 'all' && !problem.tags.includes(tagFilter)) return false;
      if (starredOnly && !problem.progress.starred) return false;
      if (!normalizedQuery) return true;
      const haystack = `${problem.name}\n${problem.tags.join(' ')}\n${problem.statement}\n${problem.progress.note}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [problems, query, resultFilter, starredOnly, tagFilter]);

  const selectedProblem = useMemo(
    () => problems.find((problem) => problem.id === selectedId) ?? null,
    [problems, selectedId]
  );

  const saveProgress = useCallback(async (problemId: string, patch: ProgressPatch) => {
    setSavingIds((current) => ({ ...current, [problemId]: true }));
    try {
      const saved = await patchProgress(problemId, patch);
      setProblems((current) =>
        current.map((problem) => {
          if (problem.id !== problemId) return problem;
          const appliedPatch: ProgressPatch = {};
          if ('opened' in patch) appliedPatch.opened = saved.opened;
          if ('starred' in patch) appliedPatch.starred = saved.starred;
          if ('note' in patch) appliedPatch.note = saved.note;
          return {
            ...problem,
            progress: {
              ...problem.progress,
              ...appliedPatch,
              updatedAt: saved.updatedAt,
            },
          };
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSavingIds((current) => ({ ...current, [problemId]: false }));
    }
  }, []);

  const updateProgress = useCallback(
    (problemId: string, patch: ProgressPatch, options: { debounceMs?: number } = {}) => {
      setError(null);
      setProblems((current) =>
        current.map((problem) =>
          problem.id === problemId
            ? {
                ...problem,
                progress: {
                  ...problem.progress,
                  ...patch,
                },
              }
            : problem
        )
      );

      if (options.debounceMs) {
        const existingTimer = noteTimersRef.current[problemId];
        if (existingTimer) window.clearTimeout(existingTimer);
        noteTimersRef.current[problemId] = window.setTimeout(() => {
          delete noteTimersRef.current[problemId];
          void saveProgress(problemId, patch);
        }, options.debounceMs);
        return;
      }

      void saveProgress(problemId, patch);
    },
    [saveProgress]
  );

  const submitProblemAnswer = useCallback(async (problemId: string, answer: string, elapsedMs: number) => {
    setError(null);
    setSubmittingIds((current) => ({ ...current, [problemId]: true }));
    try {
      const submission = await submitAnswer(problemId, answer, elapsedMs);
      setProblems((current) =>
        current.map((problem) =>
          problem.id === problemId
            ? { ...problem, submissions: [submission, ...(problem.submissions ?? [])] }
            : problem
        )
      );
      return submission;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit.');
      return null;
    } finally {
      setSubmittingIds((current) => ({ ...current, [problemId]: false }));
    }
  }, []);

  const updateSubmissionCorrectness = useCallback(async (submissionId: number, isCorrect: boolean | null) => {
    setError(null);
    setSavingSubmissionIds((current) => ({ ...current, [submissionId]: true }));
    try {
      const saved = await patchSubmissionCorrectness(submissionId, isCorrect);
      setProblems((current) =>
        current.map((problem) => ({
          ...problem,
          submissions: (problem.submissions ?? []).map((submission) =>
            submission.id === submissionId ? saved : submission
          ),
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update.');
    } finally {
      setSavingSubmissionIds((current) => ({ ...current, [submissionId]: false }));
    }
  }, []);

  const openProblem = useCallback((problemId: string) => {
    setSelectedId(problemId);
    setView('detail');
    writeRoute('detail', problemId);
  }, []);

  const goLibrary = useCallback(() => {
    setView('library');
    writeRoute('library');
  }, []);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_10%_0%,rgba(255,59,127,0.16),transparent_28%),radial-gradient(circle_at_85%_10%,rgba(0,167,255,0.14),transparent_30%),radial-gradient(circle_at_50%_100%,rgba(124,58,237,0.12),transparent_35%),#f8fafc] font-sans text-slate-900">
      <header className="sticky top-0 z-20 border-b border-fuchsia-100 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={goLibrary}
            className="group flex min-w-0 items-center gap-2 rounded-lg pr-2 text-left"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[linear-gradient(135deg,#ff3b7f,#8b5cf6,#00a7ff)] text-white shadow-sm shadow-sky-500/20 transition group-hover:scale-105">
              <Orbit size={20} strokeWidth={2.4} />
            </div>
            <h1 className="truncate bg-[linear-gradient(90deg,#ff3b7f,#8b5cf6,#00a7ff)] bg-clip-text text-lg font-extrabold text-transparent">
              Myslee
            </h1>
          </button>
          <div className="flex items-center gap-2">
            {view === 'detail' && (
            <button
              type="button"
              onClick={goLibrary}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-fuchsia-100 bg-white/90 px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-fuchsia-50"
            >
                <ArrowLeft size={16} />
                List
              </button>
            )}
            <button
              type="button"
              onClick={() => void loadProblems()}
              title="Refresh"
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-100 bg-white/90 text-slate-600 shadow-sm transition hover:bg-cyan-50"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-3 py-3 sm:px-5 sm:py-4">
        {error && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50/90 px-4 py-3 text-sm text-red-700 shadow-sm">
            <AlertCircle className="mt-0.5 shrink-0" size={18} />
            <span>{error}</span>
          </div>
        )}

        {view === 'library' && (
          <LibraryView
            allTags={allTags}
            filteredProblems={filteredProblems}
            isLoading={isLoading}
            query={query}
            setQuery={setQuery}
            resultFilter={resultFilter}
            setResultFilter={setResultFilter}
            tagFilter={tagFilter}
            setTagFilter={setTagFilter}
            starredOnly={starredOnly}
            setStarredOnly={setStarredOnly}
            onOpen={openProblem}
          />
        )}

        {view === 'detail' && (
          <DetailView
            problem={selectedProblem}
            isLoading={isLoading}
            isSaving={selectedProblem ? !!savingIds[selectedProblem.id] : false}
            isSubmitting={selectedProblem ? !!submittingIds[selectedProblem.id] : false}
            savingSubmissionIds={savingSubmissionIds}
            onBack={goLibrary}
            onUpdate={(patch, options) => {
              if (selectedProblem) updateProgress(selectedProblem.id, patch, options);
            }}
            onSubmitAnswer={(answer, elapsedMs) => (
              selectedProblem ? submitProblemAnswer(selectedProblem.id, answer, elapsedMs) : Promise.resolve(null)
            )}
            onUpdateSubmissionCorrectness={updateSubmissionCorrectness}
          />
        )}
      </main>
    </div>
  );
}

function LibraryView({
  allTags,
  filteredProblems,
  isLoading,
  query,
  setQuery,
  resultFilter,
  setResultFilter,
  tagFilter,
  setTagFilter,
  starredOnly,
  setStarredOnly,
  onOpen,
}: {
  allTags: string[];
  filteredProblems: Problem[];
  isLoading: boolean;
  query: string;
  setQuery: (value: string) => void;
  resultFilter: ResultFilter;
  setResultFilter: (value: ResultFilter) => void;
  tagFilter: string;
  setTagFilter: (value: string) => void;
  starredOnly: boolean;
  setStarredOnly: (updater: (value: boolean) => boolean) => void;
  onOpen: (problemId: string) => void;
}) {
  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
      <section className="min-w-0 rounded-lg border border-white/70 bg-white/85 p-3 shadow-sm shadow-fuchsia-950/5 backdrop-blur lg:sticky lg:top-20">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded-lg border border-fuchsia-100 bg-white/95 py-2.5 pl-10 pr-3 text-sm outline-none transition focus:border-fuchsia-400 focus:ring-4 focus:ring-fuchsia-500/10"
            placeholder="Search"
          />
        </div>

        <div className="mt-3 flex max-w-full items-center gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:items-stretch lg:overflow-visible lg:pb-0">
          <span className="flex shrink-0 items-center gap-1.5 px-1 text-xs font-semibold uppercase text-slate-500">
            <Filter size={14} />
            Filter
          </span>
          {RESULT_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              title={option.title}
              onClick={() => setResultFilter(option.id)}
              className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-full border px-2.5 py-1.5 text-sm font-semibold transition lg:w-full lg:justify-start ${
                resultFilter === option.id
                  ? 'border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-fuchsia-50/50'
              }`}
            >
              {option.id === 'all' ? 'All' : <ResultPill state={option.id} />}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setStarredOnly((value) => !value)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-sm font-semibold transition lg:w-full ${
              starredOnly
                ? 'border-amber-300 bg-amber-50 text-amber-700'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-amber-50/70'
            }`}
          >
            <Star size={14} fill={starredOnly ? 'currentColor' : 'none'} />
            Starred
          </button>
        </div>

        {allTags.length > 0 && (
          <div className="mt-3 flex max-w-full gap-1.5 overflow-x-auto pb-1 lg:max-h-[calc(100vh-22rem)] lg:flex-wrap lg:overflow-y-auto lg:pb-0">
            <button
              type="button"
              onClick={() => setTagFilter('all')}
              className={`shrink-0 rounded-full border px-2.5 py-1 text-sm font-medium transition ${
                tagFilter === 'all'
                  ? 'border-transparent bg-[linear-gradient(90deg,#ff3b7f,#7c3aed)] text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-violet-50/70'
              }`}
            >
              All tags
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(tag)}
                className={`shrink-0 rounded-full border px-2.5 py-1 text-sm font-medium transition ${
                  tagFilter === tag
                    ? 'border-transparent bg-[linear-gradient(90deg,#00a7ff,#7c3aed)] text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-violet-50/70'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="min-w-0 space-y-1.5">
        {isLoading && (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500 shadow-sm">
            Loading...
          </div>
        )}

        {!isLoading &&
          filteredProblems.map((problem) => (
            <ProblemRow key={problem.id} problem={problem} onOpen={() => onOpen(problem.id)} />
          ))}

        {!isLoading && filteredProblems.length === 0 && (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500 shadow-sm">
            No results
          </div>
        )}
      </section>
    </div>
  );
}

function ProblemRow({ problem, onOpen }: { problem: Problem; onOpen: () => void }) {
  const title = resultTitle(problem);
  const state = resultState(problem);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid min-h-12 w-full grid-cols-[2.25rem_minmax(0,1fr)_1.5rem] items-center gap-2 rounded-lg border border-white/70 bg-white/90 px-2 py-1.5 text-left shadow-sm shadow-fuchsia-950/5 transition hover:border-fuchsia-200 hover:bg-white hover:shadow-md sm:px-2.5"
    >
      <ResultPill state={state} title={title} />
      <span className="min-w-0 truncate text-sm font-semibold text-slate-950 sm:text-[15px]">{problem.name}</span>
      <span className="flex h-6 w-6 items-center justify-center">
        {problem.progress.starred && <Star size={14} className="shrink-0 text-amber-500" fill="currentColor" />}
      </span>
    </button>
  );
}

function DetailView({
  problem,
  isLoading,
  isSaving,
  isSubmitting,
  savingSubmissionIds,
  onBack,
  onUpdate,
  onSubmitAnswer,
  onUpdateSubmissionCorrectness,
}: {
  problem: Problem | null;
  isLoading: boolean;
  isSaving: boolean;
  isSubmitting: boolean;
  savingSubmissionIds: Record<number, boolean>;
  onBack: () => void;
  onUpdate: (patch: ProgressPatch, options?: { debounceMs?: number }) => void;
  onSubmitAnswer: (answer: string, elapsedMs: number) => Promise<Submission | null>;
  onUpdateSubmissionCorrectness: (submissionId: number, isCorrect: boolean | null) => void;
}) {
  if (isLoading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
        Loading...
      </div>
    );
  }

  if (!problem) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-sm text-slate-500">Not found</p>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <ProblemDetail
      problem={problem}
      isSaving={isSaving}
      isSubmitting={isSubmitting}
      savingSubmissionIds={savingSubmissionIds}
      onBack={onBack}
      onUpdate={onUpdate}
      onSubmitAnswer={onSubmitAnswer}
      onUpdateSubmissionCorrectness={onUpdateSubmissionCorrectness}
    />
  );
}

function ProblemDetail({
  problem,
  isSaving,
  isSubmitting,
  savingSubmissionIds,
  onBack,
  onUpdate,
  onSubmitAnswer,
  onUpdateSubmissionCorrectness,
}: {
  problem: Problem;
  isSaving: boolean;
  isSubmitting: boolean;
  savingSubmissionIds: Record<number, boolean>;
  onBack: () => void;
  onUpdate: (patch: ProgressPatch, options?: { debounceMs?: number }) => void;
  onSubmitAnswer: (answer: string, elapsedMs: number) => Promise<Submission | null>;
  onUpdateSubmissionCorrectness: (submissionId: number, isCorrect: boolean | null) => void;
}) {
  const [hintOpen, setHintOpen] = useState(false);
  const [solutionOpen, setSolutionOpen] = useState(false);
  const [submissionsOpen, setSubmissionsOpen] = useState(false);
  const [latestSubmissionId, setLatestSubmissionId] = useState<number | null>(null);
  const [answer, setAnswer] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const timerStartRef = useRef<number | null>(null);
  const isLocked = !problem.progress.opened;

  useEffect(() => {
    setHintOpen(false);
    setSolutionOpen(false);
    setSubmissionsOpen(false);
    setLatestSubmissionId(null);
    setAnswer('');
    setElapsedMs(0);
    timerStartRef.current = null;
  }, [problem.id]);

  useEffect(() => {
    if (isLocked) {
      timerStartRef.current = null;
      setElapsedMs(0);
      return;
    }
    timerStartRef.current = Date.now();
    setElapsedMs(0);
    const interval = window.setInterval(() => {
      if (timerStartRef.current !== null) {
        setElapsedMs(Date.now() - timerStartRef.current);
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, [isLocked, problem.id]);

  const resetTimer = () => {
    timerStartRef.current = Date.now();
    setElapsedMs(0);
  };

  const handleSubmit = async () => {
    const trimmed = answer.trim();
    if (!trimmed || isSubmitting) return;
    const submission = await onSubmitAnswer(trimmed, elapsedMs);
    if (submission) {
      setLatestSubmissionId(submission.id);
    }
  };

  const latestSubmission = latestSubmissionId
    ? (problem.submissions ?? []).find((submission) => submission.id === latestSubmissionId) ?? null
    : null;

  return (
    <article className="overflow-hidden rounded-lg border border-fuchsia-100 bg-white shadow-sm shadow-fuchsia-950/5">
      <div className="border-b border-fuchsia-100 bg-[linear-gradient(135deg,rgba(255,59,127,0.10),rgba(0,167,255,0.09),rgba(124,58,237,0.08))] px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 rounded-lg border border-fuchsia-100 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-fuchsia-50"
            >
              <ArrowLeft size={16} />
              List
            </button>
            <button
              type="button"
              title={problem.progress.starred ? 'Unstar' : 'Star'}
              onClick={() => onUpdate({ starred: !problem.progress.starred })}
              className={`flex h-10 w-10 items-center justify-center rounded-lg border transition ${
                problem.progress.starred
                  ? 'border-amber-300 bg-amber-50 text-amber-600'
                  : 'border-fuchsia-100 bg-white text-slate-500 hover:bg-fuchsia-50'
              }`}
            >
              <Star size={18} fill={problem.progress.starred ? 'currentColor' : 'none'} />
            </button>
          </div>

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-fuchsia-200 bg-white/80 px-3 py-1 text-xs font-semibold text-fuchsia-700 shadow-sm shadow-fuchsia-500/10">
                #{String(problem.index).padStart(2, '0')}
              </span>
              <span className="text-xs font-medium text-violet-500/80">{isSaving ? 'Saving...' : formatUpdatedAt(problem.progress.updatedAt)}</span>
            </div>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-violet-950 sm:text-3xl">{problem.name}</h2>
          </div>
        </div>
      </div>

      {isLocked ? (
        <div className="space-y-4 px-4 py-5 sm:px-5">
          <LockedProblem onOpen={() => onUpdate({ opened: true })} />
          <SubmissionHistory
            submissions={problem.submissions ?? []}
            open={submissionsOpen}
            savingSubmissionIds={savingSubmissionIds}
            onToggle={() => setSubmissionsOpen((value) => !value)}
            onUpdateCorrectness={onUpdateSubmissionCorrectness}
          />
        </div>
      ) : (
        <div className="space-y-5 px-4 py-5 sm:px-5">
          <section>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase text-slate-500">
              <BookOpen size={16} />
              Statement
            </h3>
            <div className="rounded-lg border border-cyan-100 bg-white/80 px-4 py-4 shadow-sm shadow-cyan-950/5">
              <MarkdownContent>{problem.statement}</MarkdownContent>
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase text-slate-500">
              <PencilLine size={16} />
              Answer
            </h3>
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              className="min-h-36 w-full resize-y rounded-lg border border-fuchsia-100 bg-white px-3 py-3 text-sm leading-6 text-slate-800 outline-none transition focus:border-fuchsia-400 focus:ring-4 focus:ring-fuchsia-500/10"
              placeholder="Write your answer"
            />
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex items-center gap-1.5 text-sm font-medium text-slate-500">
                  <Timer size={16} />
                  <span className="tabular-nums">{formatDuration(elapsedMs)}</span>
                </div>
                <button
                  type="button"
                  onClick={resetTimer}
                  title="Reset timer"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-100 bg-white text-violet-600 shadow-sm shadow-violet-500/10 transition hover:border-violet-200 hover:bg-violet-50"
                >
                  <RotateCcw size={16} />
                </button>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!answer.trim() || isSubmitting}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[linear-gradient(90deg,#ff3b7f,#7c3aed,#00a7ff)] px-3 text-sm font-semibold text-white shadow-sm shadow-fuchsia-500/20 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60 sm:px-4"
                >
                  <Send size={16} />
                  {isSubmitting ? 'Submitting...' : 'Submit'}
                </button>
              </div>
            </div>
            {latestSubmission && (
              <CurrentSubmissionResult
                submission={latestSubmission}
                isSaving={!!savingSubmissionIds[latestSubmission.id]}
                onUpdateCorrectness={(isCorrect) => onUpdateSubmissionCorrectness(latestSubmission.id, isCorrect)}
              />
            )}
          </section>

          <section>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase text-slate-500">
              <PencilLine size={16} />
              Notes
            </h3>
            <textarea
              value={problem.progress.note}
              onChange={(event) => onUpdate({ note: event.target.value }, { debounceMs: 500 })}
              className="min-h-36 w-full resize-y rounded-lg border border-violet-100 bg-white px-3 py-3 text-sm leading-6 text-slate-800 outline-none transition focus:border-violet-400 focus:ring-4 focus:ring-violet-500/10"
              placeholder="Notes"
            />
          </section>

          <RevealPanel
            title="Hint"
            icon={<Lightbulb className="text-amber-500" size={16} />}
            open={hintOpen}
            onToggle={() => setHintOpen((value) => !value)}
          >
            <MarkdownContent>{problem.hint}</MarkdownContent>
          </RevealPanel>

          <RevealPanel
            title="Solution"
            icon={<CheckCircle2 className="text-emerald-500" size={16} />}
            open={solutionOpen}
            onToggle={() => setSolutionOpen((value) => !value)}
          >
            {problem.tags.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {problem.tags.map((tag) => (
                  <TagPill key={tag}>{tag}</TagPill>
                ))}
              </div>
            )}
            <MarkdownContent>{problem.solution}</MarkdownContent>
          </RevealPanel>

          <SubmissionHistory
            submissions={problem.submissions ?? []}
            open={submissionsOpen}
            savingSubmissionIds={savingSubmissionIds}
            onToggle={() => setSubmissionsOpen((value) => !value)}
            onUpdateCorrectness={onUpdateSubmissionCorrectness}
          />
        </div>
      )}
    </article>
  );
}

function SubmissionHistory({
  submissions,
  open,
  savingSubmissionIds,
  onToggle,
  onUpdateCorrectness,
}: {
  submissions: Submission[];
  open: boolean;
  savingSubmissionIds: Record<number, boolean>;
  onToggle: () => void;
  onUpdateCorrectness: (submissionId: number, isCorrect: boolean | null) => void;
}) {
  return (
    <section className="rounded-lg border border-slate-200">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
      >
        <span className="flex items-center gap-2 text-sm font-semibold uppercase text-slate-500">
          <History className="text-violet-500" size={16} />
          Submissions
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{submissions.length}</span>
        </span>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
          {open ? <EyeOff size={16} /> : <Eye size={16} />}
        </span>
      </button>
      {open && (
        <div className="border-t border-slate-200 bg-white p-4">
          {submissions.length === 0 ? (
            <div className="rounded-lg bg-slate-50 px-4 py-5 text-sm text-slate-500">No submissions</div>
          ) : (
            <div className="space-y-3">
              {submissions.map((submission) => (
                <SubmissionCard
                  key={submission.id}
                  submission={submission}
                  isSaving={!!savingSubmissionIds[submission.id]}
                  onUpdateCorrectness={(isCorrect) => onUpdateCorrectness(submission.id, isCorrect)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CurrentSubmissionResult({
  submission,
  isSaving,
  onUpdateCorrectness,
}: {
  submission: Submission;
  isSaving: boolean;
  onUpdateCorrectness: (isCorrect: boolean | null) => void;
}) {
  return (
    <div className="mt-4 rounded-lg border border-fuchsia-100 bg-[linear-gradient(135deg,rgba(255,59,127,0.10),rgba(0,167,255,0.10),rgba(124,58,237,0.08))] px-3 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="bg-[linear-gradient(90deg,#ff3b7f,#7c3aed,#00a7ff)] bg-clip-text text-xs font-extrabold uppercase text-transparent">
            Current result
          </span>
          <span className="text-xs font-semibold text-slate-500 tabular-nums">{formatDuration(submission.elapsedMs)}</span>
          {isSaving && <span className="text-xs text-slate-400">Saving...</span>}
        </div>
        <CorrectnessControls value={submission.isCorrect} onUpdateCorrectness={onUpdateCorrectness} />
      </div>
      <div className="mt-2 rounded-lg bg-white px-3 py-3">
        {submission.feedback ? (
          <MarkdownContent>{submission.feedback}</MarkdownContent>
        ) : (
          <p className="text-sm text-slate-500">No feedback returned.</p>
        )}
      </div>
    </div>
  );
}

function SubmissionCard({
  submission,
  isSaving,
  onUpdateCorrectness,
}: {
  submission: Submission;
  isSaving: boolean;
  onUpdateCorrectness: (isCorrect: boolean | null) => void;
}) {
  return (
    <article className="rounded-lg border border-white/70 bg-white/95 p-4 shadow-sm shadow-violet-950/5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-400">{formatUpdatedAt(submission.createdAt)}</span>
            <span className="text-xs font-semibold text-slate-500 tabular-nums">{formatDuration(submission.elapsedMs)}</span>
            {isSaving && <span className="text-xs text-slate-400">Saving...</span>}
          </div>
        </div>
        <CorrectnessControls value={submission.isCorrect} onUpdateCorrectness={onUpdateCorrectness} />
      </div>
      <div className="mt-3 rounded-lg bg-violet-50/50 px-3 py-3">
        <MarkdownContent>{submission.answer}</MarkdownContent>
      </div>
      {submission.feedback && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-3">
          <MarkdownContent>{submission.feedback}</MarkdownContent>
        </div>
      )}
    </article>
  );
}

function CorrectnessControls({
  value,
  onUpdateCorrectness,
}: {
  value: boolean | null;
  onUpdateCorrectness: (isCorrect: boolean | null) => void;
}) {
  return (
    <div className="flex shrink-0 gap-1">
      <CorrectnessButton
        active={value === false}
        tone="red"
        title="Mark wrong"
        onClick={() => onUpdateCorrectness(false)}
      >
        <X size={15} strokeWidth={2.6} />
      </CorrectnessButton>
      <CorrectnessButton
        active={value === true}
        tone="green"
        title="Mark correct"
        onClick={() => onUpdateCorrectness(true)}
      >
        <Check size={15} strokeWidth={2.6} />
      </CorrectnessButton>
      <CorrectnessButton
        active={value === null}
        tone="violet"
        title="Mark unknown"
        onClick={() => onUpdateCorrectness(null)}
      >
        <CircleHelp size={15} strokeWidth={2.4} />
      </CorrectnessButton>
    </div>
  );
}

function CorrectnessButton({
  active,
  tone,
  title,
  onClick,
  children,
}: {
  active: boolean;
  tone: 'red' | 'green' | 'violet';
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const activeTone = {
    red: 'border-red-200 bg-red-50 text-red-600',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-600',
    violet: 'border-violet-200 bg-violet-50 text-violet-600',
  }[tone];
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-full border px-2 transition ${
        active
          ? `${activeTone} opacity-100`
          : 'border-slate-200 bg-white text-slate-400 opacity-50 hover:bg-slate-50 hover:opacity-90'
      }`}
    >
      {children}
    </button>
  );
}

function LockedProblem({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="px-4 py-12 sm:px-5">
      <div className="mx-auto flex max-w-md flex-col items-center text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <Lock size={24} />
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="mt-6 inline-flex items-center justify-center rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
        >
          Open
        </button>
      </div>
    </div>
  );
}

function RevealPanel({
  title,
  icon,
  open,
  onToggle,
  children,
}: {
  title: string;
  icon: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
      >
        <span className="flex items-center gap-2 text-sm font-semibold uppercase text-slate-500">
          {icon}
          {title}
        </span>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
          {open ? <EyeOff size={16} /> : <Eye size={16} />}
        </span>
      </button>
      {open && <div className="border-t border-slate-200 bg-white px-4 py-4">{children}</div>}
    </section>
  );
}

export default App;
