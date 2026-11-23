import type { Job } from '../batch/queue';

export type RunState = { active: boolean; total: number; finished: number; cancelled: boolean };

type Props = {
  jobs: Job[];
  run: RunState | null;
  destination: string;
  startLabel: string;
  onEdit: (id: number) => void;
  onRemove: (id: number) => void;
  onStart: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onDismissSummary: () => void;
};

const STATUS: Record<Job['status'], string> = {
  analyzing: 'Analysing…', ready: 'Ready', skipped: 'Skipped', unsupported: 'Not supported',
  running: 'Correcting…', done: 'Done', failed: 'Failed',
};

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function QueueView({ jobs, run, destination, startLabel, onEdit, onRemove, onStart, onCancel, onRetry, onDismissSummary }: Props) {
  const count = (status: Job['status']) => jobs.filter((j) => j.status === status).length;
  const ready = count('ready'), analyzing = count('analyzing'), done = count('done'), failed = count('failed');
  const left = count('skipped') + count('unsupported');
  const active = !!run?.active;
  const notes = jobs.filter((j) => j.status === 'done' && j.result?.note);
  const noun = jobs.some((j) => j.source.kind === 'video') ? 'file' : 'photo';

  return (
    <main className="queue">
      <section className="queue-head">
        {active ? (
          <>
            <div className="queue-title">Correcting {run!.finished + 1 > run!.total ? run!.total : run!.finished + 1} of {run!.total}</div>
            <progress max={run!.total} value={run!.finished} aria-label="Overall progress" />
            <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          </>
        ) : run ? (
          <div className="summary" role="status">
            <div className="queue-title">
              {run.cancelled ? 'Cancelled. ' : ''}{plural(done, noun)} corrected{failed ? `, ${failed} failed` : ''}{left ? `, ${left} left out` : ''}
            </div>
            <p>{destination}</p>
            {notes.length > 0 && <p className="warning">{plural(notes.length, noun)} could not be saved as requested; see the notes below.</p>}
            <div className="summary-actions">
              {failed > 0 && <button type="button" className="primary" onClick={onRetry}>Retry failed</button>}
              {ready > 0 && <button type="button" className="primary" onClick={onStart}>{startLabel}</button>}
              <button type="button" className="ghost" onClick={onDismissSummary}>OK</button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <div className="queue-title">
                {plural(ready, noun)} ready{analyzing ? `, ${analyzing} being analysed` : ''}{left ? `, ${left} left out` : ''}
              </div>
              <p>{destination}</p>
            </div>
            <button type="button" className="primary" onClick={onStart} disabled={ready === 0}>{startLabel}</button>
          </>
        )}
      </section>

      <ul className="jobs">
        {jobs.map((job) => {
          const editable = !active && (job.status === 'ready' || job.status === 'done' || job.status === 'failed');
          const detail = job.status === 'done' ? job.result?.note ?? job.result?.location : job.message;
          return (
            <li key={job.id} className={'job ' + job.status}>
              <button type="button" className="job-main" disabled={!editable} onClick={() => onEdit(job.id)} aria-label={`Edit ${job.source.name}`}>
                {job.thumb ? <img src={job.thumb} alt="" /> : <span className="thumb-empty" aria-hidden="true" />}
                <span className="job-text">
                  <span className="job-name">{job.source.name}</span>
                  <span className="job-meta">
                    {job.video ? `Video ${clock(job.video.duration)} · ` : ''}{job.width ? `${job.width} × ${job.height} · ` : ''}{megabytes(job.source.file.size)}
                  </span>
                  {detail && <span className="job-detail">{detail}</span>}
                  {job.status === 'running' && <progress max={1} value={job.progress ?? 0} aria-label="Progress" />}
                </span>
              </button>
              <span className="chip">{STATUS[job.status]}</span>
              <button type="button" className="remove" onClick={() => onRemove(job.id)} disabled={active} aria-label={`Remove ${job.source.name}`} title="Remove">×</button>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
