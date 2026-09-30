import { useMemo } from 'react';
import { CronError, formatInZone, nextRuns, scheduleOf } from '@shared/cron.js';

/**
 * Under a Schedule node's settings: when it will run next, on the clock of the zone it was set in — so a wrong cron expression or time
 * zone shows before anything is saved. Problems are already listed at the top of the panel, so a schedule with one shows nothing here.
 */
export default function SchedulePreview({ data }) {
  const view = useMemo(() => {
    try {
      const s = scheduleOf(data);
      if (s.mode === 'every') return { every: true };
      return { tz: s.tz, runs: nextRuns(s.cron, s.tz, Date.now(), 5).map((t) => ({ at: t, text: formatInZone(t, s.tz) })) };
    } catch (e) {
      if (e instanceof CronError) return null;
      throw e;
    }
  }, [data.mode, data.every, data.unit, data.time, data.days, data.cron, data.timezone]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!view) return null;
  if (view.every) {
    return <p className="help schedule-preview">Counts from when the flow is saved, and keeps counting when other flows are saved. To run at a time of day, choose “At a set time of day”.</p>;
  }
  return (
    <div className="field schedule-preview" aria-label="Next runs">
      <label>Next runs <span className="tiny muted">({view.tz})</span></label>
      <ol className="schedule-runs">
        {view.runs.map((r) => <li key={r.at}>{r.text}</li>)}
      </ol>
    </div>
  );
}
