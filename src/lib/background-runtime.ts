// src/lib/background-runtime.ts

import { startProactive, stopProactive, isProactiveStarted } from './proactive';
import { startAlarmEngine, stopAlarmEngine, isAlarmEngineStarted } from './alarm-engine';
import { reminderScheduler } from './reminder-scheduler';
import type { ReminderRepository } from './reminder-repo';

export interface BackgroundRuntimeStatus {
  isRunning: boolean;
  userId?: string;
  schedulerActive: boolean;
  proactiveActive: boolean;
  alarmEngineActive: boolean;
}

export class BackgroundRuntimeCoordinator {
  private running = false;

  public start(): void {
    if (this.running) return;
    this.running = true;

    startAlarmEngine();
    startProactive();
    reminderScheduler.start();
  }

  public stop(): void {
    if (!this.running) {
      stopAlarmEngine();
      stopProactive();
      reminderScheduler.stop();
      return;
    }
    this.running = false;

    reminderScheduler.stop();
    stopProactive();
    stopAlarmEngine();
  }

  public isStarted(): boolean {
    return this.running;
  }

  public setUser(userId?: string, repo?: ReminderRepository): void {
    reminderScheduler.setUser(userId, repo);
  }

  public status(): BackgroundRuntimeStatus {
    return {
      isRunning: this.running,
      userId: reminderScheduler.getUserId(),
      schedulerActive: reminderScheduler.isActive(),
      proactiveActive: isProactiveStarted(),
      alarmEngineActive: isAlarmEngineStarted(),
    };
  }
}

export const backgroundRuntime = new BackgroundRuntimeCoordinator();
export { BackgroundRuntimeCoordinator as BackgroundRuntime };
