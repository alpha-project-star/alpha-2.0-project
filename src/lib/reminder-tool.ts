import { z } from 'zod';
import { 
  FirestoreReminder, 
  ReminderRepository, 
  ReminderState 
} from './reminder-repo';
import { uid } from './alpha-store';
import { interpretReminderDate, formatReminderDate } from './reminder-date-utils';
import { temporal } from './temporal';
import { reminderContextManager } from './reminder-context';

// Validation Schemas
export const CreateReminderSchema = z.object({
  title: z.string().min(1, "Title is required"),
  dueAt: z.union([z.number(), z.string()]).describe("Unix timestamp or natural language string"),
  notes: z.string().optional().default('')
});

export const UpdateReminderSchema = z.object({
  id: z.string().optional(),
  idOrQuery: z.string().optional(),
  query: z.string().optional().describe("Search query if ID is unknown"),
  title: z.string().min(1).optional(),
  dueAt: z.union([z.number(), z.string()]).optional(),
  notes: z.string().optional(),
  reminderState: z.enum(['active', 'completed', 'cancelled']).optional()
});

export type ToolErrorCode = 
  | 'UNAUTHENTICATED' 
  | 'INVALID_INPUT' 
  | 'NOT_FOUND' 
  | 'AMBIGUOUS'
  | 'REPOSITORY_ERROR'
  | 'UID_MISMATCH';

export interface ToolResult<T = any> {
  success: boolean;
  operation: string;
  data?: T;
  error?: {
    code: ToolErrorCode;
    message: string;
    candidates?: FirestoreReminder[];
  };
}

/**
 * ReminderTool provides a validated, authenticated interface for reminder operations.
 */
export class ReminderTool {
  constructor(
    private readonly userId: string | null,
    private readonly repo: ReminderRepository
  ) {}

  private checkAuth(): string {
    return this.userId || 'local-user';
  }

  async createReminder(input: any): Promise<ToolResult<FirestoreReminder>> {
    const op = 'createReminder';
    try {
      const userId = this.checkAuth();
      const validated = CreateReminderSchema.safeParse(input);
      
      if (!validated.success) {
        return this.fail('INVALID_INPUT', validated.error.errors[0].message, op);
      }

      const { title, dueAt: rawDue, notes } = validated.data;
      
      const dueAt = interpretReminderDate(rawDue, temporal.now());
      if (dueAt === null) {
        return this.fail('INVALID_INPUT', `Could not understand the time: "${rawDue}"`, op);
      }

      const nowTime = temporal.now().getTime();
      if (dueAt < nowTime - 60000) { // Allow 1 minute grace
         return this.fail('INVALID_INPUT', `The time ${formatReminderDate(dueAt)} is in the past.`, op);
      }

      const reminder: FirestoreReminder = {
        id: uid(),
        userId,
        title,
        notes: notes || '',
        dueAt,
        createdAt: nowTime,
        updatedAt: nowTime,
        reminderState: 'active' as ReminderState,
        notificationState: 'pending'
      };

      await this.repo.createReminder(userId, reminder);
      
      reminderContextManager.setContext(userId, reminder);
      
      return { success: true, operation: op, data: reminder };
    } catch (e: any) {
      return this.handleError(e, op);
    }
  }

  async getReminder(idOrQuery?: string): Promise<ToolResult<FirestoreReminder>> {
    const op = 'getReminder';
    try {
      const userId = this.checkAuth();
      const activeCtx = reminderContextManager.getContext(userId);
      const targetIdOrQuery = idOrQuery || activeCtx?.id;
      if (!targetIdOrQuery) return this.fail('INVALID_INPUT', 'Reminder ID or search query is required', op);

      // Try as ID first
      let reminder = await this.repo.getReminder(userId, targetIdOrQuery);
      
      // If not found by ID, try searching
      if (!reminder) {
        const matches = await this.findReminders(userId, targetIdOrQuery);
        if (matches.length === 0) {
          return this.fail('NOT_FOUND', `Could not find any reminder matching "${targetIdOrQuery}"`, op);
        }
        if (matches.length > 1) {
          return this.fail('AMBIGUOUS', `Multiple reminders found for "${targetIdOrQuery}"`, op, matches);
        }
        reminder = matches[0];
      }

      reminderContextManager.setContext(userId, reminder);
      return { success: true, operation: op, data: reminder };
    } catch (e: any) {
      return this.handleError(e, op);
    }
  }

  async listReminders(): Promise<ToolResult<FirestoreReminder[]>> {
    const op = 'listReminders';
    try {
      const userId = this.checkAuth();
      const reminders = await this.repo.listReminders(userId);
      return { success: true, operation: op, data: reminders };
    } catch (e: any) {
      return this.handleError(e, op);
    }
  }

  async updateReminder(input: any): Promise<ToolResult<FirestoreReminder>> {
    const op = 'updateReminder';
    try {
      const userId = this.checkAuth();
      const validated = UpdateReminderSchema.safeParse(input);
      
      if (!validated.success) {
        return this.fail('INVALID_INPUT', validated.error.errors[0].message, op);
      }

      const activeCtx = reminderContextManager.getContext(userId);
      const { id, idOrQuery, query, dueAt: rawDue, ...patch } = validated.data;
      
      let targetId = id || idOrQuery;
      if (!targetId && !query && activeCtx) {
        targetId = activeCtx.id;
      }

      if (!targetId) {
        if (!query) return this.fail('INVALID_INPUT', 'Either ID or query is required', op);
        const matches = await this.findReminders(userId, query);
        if (matches.length === 0) return this.fail('NOT_FOUND', `No reminder found for "${query}"`, op);
        if (matches.length > 1) return this.fail('AMBIGUOUS', `Multiple matches for "${query}"`, op, matches);
        targetId = matches[0].id;
      }

      // Verify existence
      let existing = await this.repo.getReminder(userId, targetId);
      if (!existing) {
        const matches = await this.findReminders(userId, targetId);
        if (matches.length === 1) {
          targetId = matches[0].id;
          existing = matches[0];
        } else if (matches.length > 1) {
          return this.fail('AMBIGUOUS', `Multiple matches for "${targetId}"`, op, matches);
        } else {
          return this.fail('NOT_FOUND', `Reminder with ID ${targetId} not found`, op);
        }
      }

      const updatedPatch: Partial<FirestoreReminder> = {
        ...patch,
        updatedAt: temporal.now().getTime()
      };

      if (rawDue !== undefined) {
        const dueAt = interpretReminderDate(rawDue, temporal.now());
        if (dueAt === null) return this.fail('INVALID_INPUT', `Invalid time: ${rawDue}`, op);
        updatedPatch.dueAt = dueAt;
      }

      await this.repo.updateReminder(userId, targetId!, updatedPatch);
      
      const updated = await this.repo.getReminder(userId, targetId!);
      reminderContextManager.setContext(userId, updated!);
      return { success: true, operation: op, data: updated! };
    } catch (e: any) {
      return this.handleError(e, op);
    }
  }

  async deleteReminder(idOrQuery?: string): Promise<ToolResult<{ id: string; title: string }>> {
    const op = 'deleteReminder';
    try {
      const userId = this.checkAuth();
      const activeCtx = reminderContextManager.getContext(userId);
      const targetIdOrQuery = idOrQuery || activeCtx?.id;
      if (!targetIdOrQuery) return this.fail('INVALID_INPUT', 'Reminder ID or query is required', op);

      let target: FirestoreReminder | null = await this.repo.getReminder(userId, targetIdOrQuery);
      
      if (!target) {
        const matches = await this.findReminders(userId, targetIdOrQuery);
        if (matches.length === 0) return this.fail('NOT_FOUND', `No reminder found for "${targetIdOrQuery}"`, op);
        if (matches.length > 1) return this.fail('AMBIGUOUS', `Multiple matches for "${targetIdOrQuery}"`, op, matches);
        target = matches[0];
      }

      await this.repo.deleteReminder(userId, target.id);
      reminderContextManager.invalidate(userId, target.id);
      return { success: true, operation: op, data: { id: target.id, title: target.title } };
    } catch (e: any) {
      return this.handleError(e, op);
    }
  }

  async completeReminder(idOrQuery?: string): Promise<ToolResult<FirestoreReminder>> {
    return this.updateReminder({ id: idOrQuery, reminderState: 'completed' });
  }

  private async findReminders(userId: string, query: string): Promise<FirestoreReminder[]> {
    const all = await this.repo.listReminders(userId);
    const q = query.toLowerCase();
    return all.filter(r => 
      r.title.toLowerCase().includes(q) || 
      (r.notes && r.notes.toLowerCase().includes(q))
    );
  }

  private fail(code: ToolErrorCode, message: string, operation: string, candidates?: FirestoreReminder[]): ToolResult {
    return {
      success: false,
      operation,
      error: { code, message, candidates }
    };
  }

  private handleError(e: any, operation: string): ToolResult {
    if (e.code === 'UNAUTHENTICATED' || e.message === 'UNAUTHENTICATED') {
      return this.fail('UNAUTHENTICATED', 'User must be authenticated', operation);
    }
    return this.fail('REPOSITORY_ERROR', e.message || 'Error occurred', operation);
  }
}
