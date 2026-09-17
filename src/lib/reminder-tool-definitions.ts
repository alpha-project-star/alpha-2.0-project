/**
 * OpenAI-compatible tool definitions for the ReminderTool.
 */
export const REMINDER_TOOLS = [
  {
    type: "function",
    function: {
      name: "createReminder",
      description: "Create a new reminder. Ask the user for any missing details (what and when) before calling this.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title of the reminder (e.g., 'Call John')." },
          dueAt: { 
            type: "string", 
            description: "When the reminder is due: either a natural-language date/time string (e.g., 'tomorrow at 9am', 'in 2 hours', 'next Monday at 3pm') or a unix timestamp in milliseconds. Alpha normalizes temporal expressions deterministically." 
          },
          notes: { type: "string", description: "Optional extra details." },
        },
        required: ["title", "dueAt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getReminder",
      description: "Get details of a specific reminder by its ID or by searching its title.",
      parameters: {
        type: "object",
        properties: {
          idOrQuery: { type: "string", description: "The unique reminder ID OR a search term for the title." },
        },
        required: ["idOrQuery"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listReminders",
      description: "List all active reminders to see what is scheduled.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updateReminder",
      description: "Update an existing reminder. Use the ID if known, otherwise provide a search query.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The ID of the reminder to update." },
          query: { type: "string", description: "Search query for the title if ID is unknown." },
          title: { type: "string", description: "New title." },
          dueAt: { type: "string", description: "New due date: either a natural-language date/time string (e.g., 'tomorrow at 9am') or a unix timestamp in milliseconds." },
          notes: { type: "string", description: "New notes." },
          reminderState: { type: "string", enum: ["active", "completed", "cancelled"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deleteReminder",
      description: "Delete a reminder permanently.",
      parameters: {
        type: "object",
        properties: {
          idOrQuery: { type: "string", description: "The ID or title search term to delete." },
        },
        required: ["idOrQuery"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "completeReminder",
      description: "Mark a specific reminder as completed.",
      parameters: {
        type: "object",
        properties: {
          idOrQuery: { type: "string", description: "The ID or title search term to complete." },
        },
        required: ["idOrQuery"],
      },
    },
  },
];
