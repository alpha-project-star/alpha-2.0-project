/**
 * OpenAI-compatible tool definitions for the ReminderTool.
 */
export const REMINDER_TOOLS = [
  {
    type: "function",
    function: {
      name: "createReminder",
      description: "Create a new reminder. CRITICAL TEMPORAL RULE: A bare 1–12 hour without AM/PM (e.g., 'tomorrow at 9', 'at 5') is ambiguous and must be clarified before the reminder is created (ask 'Do you mean 9 AM or 9 PM?'). Do not arbitrarily assume AM or PM. Explicit AM/PM (e.g. '9am', '9pm') and 24-hour values (e.g. '21:00', '13:00') are unambiguous and can be created directly. Relative durations (e.g. 'in 2 minutes') are also valid.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title of the reminder (e.g., 'Call John')." },
          dueAt: { 
            type: "string", 
            description: "When the reminder is due: either a natural-language date/time string or a unix timestamp in milliseconds. Bare 1-12 hours without AM/PM are ambiguous and require clarification." 
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
      description: "Update an existing reminder. Use the ID if known, otherwise provide a search query. Note: bare 1-12 hour expressions without AM/PM are ambiguous and require clarification.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The ID of the reminder to update." },
          query: { type: "string", description: "Search query for the title if ID is unknown." },
          title: { type: "string", description: "New title." },
          dueAt: { type: "string", description: "New due date: natural-language date/time string or timestamp. Bare 1-12 hours without AM/PM are ambiguous." },
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
  {
    type: "function",
    function: {
      name: "inspectGitHubRepo",
      description: "Inspect a GitHub repository or URL (e.g. https://github.com/owner/repo), view metadata, enumerate files/directories, inspect commits, or fetch source file content.",
      parameters: {
        type: "object",
        properties: {
          urlOrSlug: { type: "string", description: "GitHub repository URL or owner/repo slug (e.g., 'facebook/react' or 'https://github.com/owner/repo.git')." },
          subpath: { type: "string", description: "Optional file or directory path within the repository to inspect (e.g., 'src/index.ts' or 'README.md')." },
        },
        required: ["urlOrSlug"],
      },
    },
  },
];
