import { ReminderTool } from './reminder-tool';
import { LocalReminderRepository } from './reminder-repo';

/**
 * ToolContext provides the necessary environment for a tool to execute,
 * such as the current authenticated user's ID.
 */
export interface ToolContext {
  userId: string | null;
}

/**
 * Registry of tool factory functions.
 * This allows the application to instantiate tools with the correct context
 * without hardcoding them into the UI or model logic.
 */
export const toolRegistry = {
  reminders: (ctx: ToolContext) => {
    const repo = new LocalReminderRepository();
    return new ReminderTool(ctx.userId || 'local-user', repo);
  },
  listAvailable: () => [
    { id: "reminders.create", riskLevel: "WRITE" },
    { id: "reminders.list", riskLevel: "READ" },
    { id: "reminders.delete", riskLevel: "DESTRUCTIVE" },
  ],
};

/**
 * Helper to get a reminder tool instance for the current context.
 */
export function getReminderTool(userId: string | null) {
  return toolRegistry.reminders({ userId });
}
