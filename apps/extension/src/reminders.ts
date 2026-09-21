import type { ClipperSettings } from "../../../packages/core/src/types.js";

export const REMINDER_ALARM = "babel_content_clipper.idle_reminder.v1";
export const REMINDER_STATE_KEY = "babel_content_clipper.reminder_state.v1";
export const REMINDER_NOTICE_KEY = "babel_content_clipper.reminder_notice.v1";

export interface ReminderNotice {
  readonly id: string;
  readonly createdAt: string;
  readonly message: string;
}

interface ReminderState {
  version: 1;
  captureId: string;
  captureRevision: number;
  captureTime: number;
  notified: boolean;
}

export interface ReminderDependencies {
  storage: {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
  };
  alarms: {
    create(name: string, information: { when: number }): Promise<void> | void;
    clear(name: string): Promise<boolean>;
  };
  getSettings(): Promise<Pick<ClipperSettings, "reminderMinutes">>;
  listPending(): Promise<{ readonly records: readonly unknown[] }>;
  notify(notice: ReminderNotice): Promise<void> | void;
  now?(): number;
}

function stateFrom(value: unknown): ReminderState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<ReminderState>;
  return state.version === 1 && typeof state.captureId === "string" &&
    Number.isSafeInteger(state.captureRevision) && typeof state.captureTime === "number" &&
    Number.isFinite(state.captureTime) && typeof state.notified === "boolean"
    ? state as ReminderState : undefined;
}

/** Persisted, one-shot scheduling only; this controller cannot execute or claim a Job. */
export function createReminderController(dependencies: ReminderDependencies) {
  const now = dependencies.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }
  async function readState(): Promise<ReminderState | undefined> {
    return stateFrom((await dependencies.storage.get(REMINDER_STATE_KEY))[REMINDER_STATE_KEY]);
  }
  async function delay(): Promise<number | undefined> {
    const minutes = (await dependencies.getSettings()).reminderMinutes;
    return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
      ? minutes * 60_000 : undefined;
  }
  async function schedule(): Promise<void> {
    const state = await readState();
    const milliseconds = await delay();
    await dependencies.alarms.clear(REMINDER_ALARM);
    if (!state || milliseconds === undefined || state.notified) {
      if (milliseconds === undefined) await dependencies.storage.remove(REMINDER_NOTICE_KEY);
      return;
    }
    // A browser restart may miss the original alarm. Restore one future alarm,
    // never a repeating alarm or an inferred end click for an open recording.
    await dependencies.alarms.create(REMINDER_ALARM, { when: Math.max(now() + 1, state.captureTime + milliseconds) });
  }

  return {
    initialize: () => serial(schedule),
    settingsChanged: () => serial(schedule),
    captureCreated(capture: { captureId: string; createdAt: string }, revision: number): Promise<void> {
      return serial(async () => {
        const previous = await readState();
        // Core replays an earlier request with its original persisted revision.
        // Transport retries must not postpone the user's reminder indefinitely.
        if (previous && revision <= previous.captureRevision) return;
        const captureTime = Date.parse(capture.createdAt);
        if (!Number.isFinite(captureTime) || !Number.isSafeInteger(revision)) {
          throw new Error("Reminder scheduling requires a persisted capture timestamp and revision.");
        }
        await dependencies.storage.set({ [REMINDER_STATE_KEY]: {
          version: 1, captureId: capture.captureId, captureRevision: revision,
          captureTime, notified: false,
        } satisfies ReminderState });
        await dependencies.storage.remove(REMINDER_NOTICE_KEY);
        await schedule();
      });
    },
    onAlarm(name: string): Promise<void> {
      if (name !== REMINDER_ALARM) return Promise.resolve();
      return serial(async () => {
        const state = await readState();
        const milliseconds = await delay();
        if (!state || state.notified || milliseconds === undefined) {
          await dependencies.alarms.clear(REMINDER_ALARM);
          return;
        }
        if (now() < state.captureTime + milliseconds) { await schedule(); return; }
        const pending = await dependencies.listPending();
        await dependencies.alarms.clear(REMINDER_ALARM);
        await dependencies.storage.set({ [REMINDER_STATE_KEY]: { ...state, notified: true } });
        if (pending.records.length === 0) return;
        const notice: ReminderNotice = {
          id: state.captureId + ":" + state.captureRevision,
          createdAt: new Date(now()).toISOString(),
          message: "还有待处理的采集记录。可在素材夹查看，或让 Agent 查询；提醒不会自动开始处理。",
        };
        await dependencies.storage.set({ [REMINDER_NOTICE_KEY]: notice });
        // The saved extension notice remains available to clients that cannot
        // display MCP resource notifications or are currently disconnected.
        try { await dependencies.notify(notice); } catch { /* local notice is already persisted */ }
      });
    },
    dismiss: () => serial(() => dependencies.storage.remove(REMINDER_NOTICE_KEY)),
  };
}
