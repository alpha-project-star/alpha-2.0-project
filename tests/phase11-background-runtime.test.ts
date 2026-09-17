import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { backgroundRuntime } from '../src/lib/background-runtime';
import { startProactive, stopProactive, isProactiveStarted, tick, buildMorningBrief } from '../src/lib/proactive';
import { startAlarmEngine, stopAlarmEngine, isAlarmEngineStarted } from '../src/lib/alarm-engine';
import { reminderScheduler, ReminderScheduler } from '../src/lib/reminder-scheduler';
import { InMemoryReminderRepository } from '../src/lib/reminder-repo';
import { proactiveTrigger } from '../src/lib/proactive-trigger';
import { alphaStore, PersistenceError } from '../src/lib/alpha-store';
import { temporal } from '../src/lib/temporal';

describe('Phase 11 - Background Runtime & Lifecycle Coordination', () => {
  let mockStorageStore: Record<string, string> = {};
  let mockStorageFail = false;
  let originalWindow: any;
  let originalDocument: any;

  beforeEach(() => {
    mockStorageStore = {};
    mockStorageFail = false;
    originalWindow = (globalThis as any).window;
    originalDocument = (globalThis as any).document;

    const mockLocalStorage = {
      getItem: vi.fn((key: string) => {
        if (mockStorageFail) throw new Error('Storage read error');
        return mockStorageStore[key] || null;
      }),
      setItem: vi.fn((key: string, value: string) => {
        if (mockStorageFail) throw new Error('Storage write error');
        mockStorageStore[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        if (mockStorageFail) throw new Error('Storage remove error');
        delete mockStorageStore[key];
      }),
    };

    const mockDoc = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      hidden: false,
    };

    const mockWin = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      localStorage: mockLocalStorage,
      document: mockDoc,
    };

    (globalThis as any).window = mockWin;
    (globalThis as any).document = mockDoc;

    temporal.setMockDate(new Date('2026-09-17T08:00:00Z'));
    backgroundRuntime.stop();
  });

  afterEach(() => {
    backgroundRuntime.stop();
    vi.restoreAllMocks();
    if (originalWindow !== undefined) {
      (globalThis as any).window = originalWindow;
    } else {
      delete (globalThis as any).window;
    }
    if (originalDocument !== undefined) {
      (globalThis as any).document = originalDocument;
    } else {
      delete (globalThis as any).document;
    }
  });

  it('1. Coordinator owns startup and shutdown cleanly across all sub-runtimes', () => {
    expect(backgroundRuntime.isStarted()).toBe(false);
    expect(isAlarmEngineStarted()).toBe(false);
    expect(isProactiveStarted()).toBe(false);
    expect(reminderScheduler.isActive()).toBe(false);

    backgroundRuntime.start();

    expect(backgroundRuntime.isStarted()).toBe(true);
    expect(isAlarmEngineStarted()).toBe(true);
    expect(isProactiveStarted()).toBe(true);
    expect(reminderScheduler.isActive()).toBe(true);

    const st = backgroundRuntime.status();
    expect(st.isRunning).toBe(true);
    expect(st.schedulerActive).toBe(true);
    expect(st.proactiveActive).toBe(true);
    expect(st.alarmEngineActive).toBe(true);

    backgroundRuntime.stop();

    expect(backgroundRuntime.isStarted()).toBe(false);
    expect(isAlarmEngineStarted()).toBe(false);
    expect(isProactiveStarted()).toBe(false);
    expect(reminderScheduler.isActive()).toBe(false);
  });

  it('2. Repeated start and repeated stop are idempotent and safe', () => {
    backgroundRuntime.start();
    backgroundRuntime.start(); // Repeated call
    expect(backgroundRuntime.isStarted()).toBe(true);

    backgroundRuntime.stop();
    backgroundRuntime.stop(); // Repeated stop
    expect(backgroundRuntime.isStarted()).toBe(false);

    // Restart works
    backgroundRuntime.start();
    expect(backgroundRuntime.isStarted()).toBe(true);
    backgroundRuntime.stop();
  });

  it('3. Proactive runtime cleans up visibilitychange listener on stop', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    startProactive();
    expect(addSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    const installedListener = addSpy.mock.calls.find((c) => c[0] === 'visibilitychange')?.[1];

    stopProactive();
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', installedListener);
  });

  it('4. Proactive startup timer is cancelled on stop', () => {
    vi.useFakeTimers();
    startProactive();

    // Stop before 8s startup timer fires
    stopProactive();

    // Fast forward past 8s
    vi.advanceTimersByTime(10000);

    // Verify runtime is stopped
    expect(isProactiveStarted()).toBe(false);
    vi.useRealTimers();
  });

  it('5. Proactive persistence failure throws PersistenceError and is observable', async () => {
    // Upsert overdue bill first while storage is working
    alphaStore.upsertBill({
      id: 'bill-p11-fail',
      name: 'Overdue Power Bill',
      dueDate: '2026-09-01',
      balance: '150.00',
      status: 'unpaid',
      category: 'Utilities',
    });

    mockStorageFail = true;

    // Simulate tick running when storage setItem throws error
    await expect(tick(true, { now: new Date('2026-09-17T08:00:00Z') })).rejects.toThrow(PersistenceError);

    // Clean up bill for subsequent tests
    mockStorageFail = false;
    alphaStore.deleteBill('bill-p11-fail');
  });

  it('6. Morning brief distinguishes repository failure from zero due items', async () => {
    alphaStore.deleteBill('bill-p11-fail');

    const failingRepo = new InMemoryReminderRepository();
    failingRepo.shouldFail = true;

    const briefWithFailure = await buildMorningBrief({
      repo: failingRepo,
      now: new Date('2026-09-17T08:00:00Z'),
    });

    expect(briefWithFailure).toContain("I couldn't check your reminders due to a connection issue");

    const emptyRepo = new InMemoryReminderRepository();
    const briefEmpty = await buildMorningBrief({
      repo: emptyRepo,
      now: new Date('2026-09-17T08:00:00Z'),
    });

    expect(briefEmpty).toBe('');
  });

  it('7. ProactiveTrigger enforces idempotency and rejects duplicate events', async () => {
    const now = Date.now();
    const event = {
      type: 'reminder_due' as const,
      eventId: 'evt-p11-test-01',
      reminderId: 'rem-p11-01',
      userId: 'usr-p11-01',
      dueAt: now,
      detectedAt: now,
      title: 'Phase 11 Check',
    };

    alphaStore.appendChat({
      id: 'msg-p11-01',
      role: 'model',
      origin: 'proactive',
      proactiveEventId: 'evt-p11-test-01',
      text: 'Existing proactive response',
      ts: now,
    });

    const res = await proactiveTrigger.handleReminderDue(event, 'usr-p11-01');
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('ALREADY_HANDLED');
    }
  });

  it('8. ReminderScheduler delegates reminder evaluation and does not mutate localStorage', async () => {
    const repo = new InMemoryReminderRepository();
    await repo.createReminder('usr-p11-02', {
      id: 'rem-p11-02',
      userId: 'usr-p11-02',
      title: 'Durable Reminder',
      dueAt: Date.now() - 1000,
      reminderState: 'active',
      createdAt: Date.now(),
    });

    const scheduler = new ReminderScheduler('usr-p11-02', repo);
    const events = await scheduler.runTick();

    expect(events.length).toBe(1);
    expect(events[0].reminderId).toBe('rem-p11-02');

    // Storage should not contain reminder data
    expect(mockStorageStore['reminders']).toBeUndefined();
  });
});
