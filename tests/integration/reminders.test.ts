import { describe, expect, it } from "vitest";
import {
  createReminderController, REMINDER_ALARM, REMINDER_NOTICE_KEY,
  type ReminderDependencies,
} from "../../apps/extension/src/reminders.js";

function fixture() {
  let clock = Date.parse("2026-09-19T00:00:00Z");
  let minutes: number | null = 1;
  let pending = true;
  let notificationFails = false;
  const data: Record<string, unknown> = {};
  const alarms = new Map<string, { when: number }>();
  const notices: unknown[] = [];
  let queries = 0;
  const dependencies: ReminderDependencies = {
    storage: {
      async get(keys) { return Object.fromEntries((typeof keys === "string" ? [keys] : keys).map(key => [key, data[key]])); },
      async set(items) { Object.assign(data, items); },
      async remove(keys) { for (const key of typeof keys === "string" ? [keys] : keys) delete data[key]; },
    },
    alarms: {
      async create(name, value) { alarms.set(name, value); },
      async clear(name) { return alarms.delete(name); },
    },
    async getSettings() { return { reminderMinutes: minutes }; },
    async listPending() { queries += 1; return { records: pending ? [{ latestJobStatus: "pending" }] : [] }; },
    async notify(notice) { if (notificationFails) throw new Error("client offline"); notices.push(notice); },
    now: () => clock,
  };
  return {
    dependencies, data, alarms, notices, controller: createReminderController(dependencies),
    capture: (captureId: string) => ({ captureId, createdAt: new Date(clock).toISOString() }),
    advance(milliseconds: number) { clock += milliseconds; },
    setMinutes(value: number | null) { minutes = value; },
    setPending(value: boolean) { pending = value; },
    disconnectClient() { notificationFails = true; },
    get now() { return clock; }, get queries() { return queries; },
  };
}

describe("one-time idle reminders", () => {
  it("resets only for a new capture, ignores stale alarms and idempotent capture retries", async () => {
    const f = fixture();
    const first = f.capture("first");
    await f.controller.captureCreated(first, 1);
    f.advance(30_000);
    const second = f.capture("second");
    await f.controller.captureCreated(second, 2);
    const due = f.now + 60_000;
    await f.controller.captureCreated(first, 1);
    expect(f.alarms.get(REMINDER_ALARM)?.when).toBe(due);
    f.advance(30_000);
    await f.controller.onAlarm(REMINDER_ALARM);
    expect(f.queries).toBe(0);
    expect(f.notices).toHaveLength(0);
    f.advance(30_000);
    await f.controller.onAlarm(REMINDER_ALARM);
    expect(f.notices).toHaveLength(1);
    expect(f.alarms.size).toBe(0);
    f.advance(600_000);
    await f.controller.onAlarm(REMINDER_ALARM);
    await createReminderController(f.dependencies).initialize();
    expect(f.notices).toHaveLength(1);
    expect(f.alarms.size).toBe(0);
  });

  it("restores a missed alarm after restart and keeps local notice when MCP is unavailable", async () => {
    const f = fixture();
    await f.controller.captureCreated(f.capture("captured"), 1);
    f.alarms.clear();
    f.advance(120_000);
    f.disconnectClient();
    const restarted = createReminderController(f.dependencies);
    await restarted.initialize();
    expect(f.alarms.get(REMINDER_ALARM)?.when).toBe(f.now + 1);
    await restarted.onAlarm(REMINDER_ALARM);
    expect(f.data[REMINDER_NOTICE_KEY]).toMatchObject({ id: "captured:1" });
    await restarted.dismiss();
    await restarted.initialize();
    expect(f.data[REMINDER_NOTICE_KEY]).toBeUndefined();
    expect(f.alarms.size).toBe(0);
  });

  it("does not remind for saved-only or completed work and honors disabling", async () => {
    const f = fixture();
    await f.controller.captureCreated(f.capture("captured"), 1);
    f.setPending(false);
    f.advance(60_000);
    await f.controller.onAlarm(REMINDER_ALARM);
    expect(f.data[REMINDER_NOTICE_KEY]).toBeUndefined();
    expect(f.notices).toHaveLength(0);
    await f.controller.captureCreated(f.capture("new"), 2);
    f.setMinutes(null);
    await f.controller.settingsChanged();
    expect(f.alarms.size).toBe(0);
    await f.controller.onAlarm(REMINDER_ALARM);
    expect(f.notices).toHaveLength(0);
  });
});
