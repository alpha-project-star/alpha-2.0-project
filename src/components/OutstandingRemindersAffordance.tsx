import { useState } from 'react';
import { Bell, ChevronDown, ChevronUp, Clock, Check, RefreshCw } from 'lucide-react';
import { useNotificationUIState } from '../lib/notification-ui-state';

export function OutstandingRemindersAffordance() {
  const {
    outstandingRecords,
    outstandingCount,
    acknowledge,
    actionError,
  } = useNotificationUIState();
  const [expanded, setExpanded] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  if (outstandingCount === 0) {
    return null;
  }

  const handleItemAcknowledge = async (eventId: string, reminderId?: string) => {
    setProcessingId(eventId);
    await acknowledge(eventId, reminderId);
    setProcessingId(null);
  };

  return (
    <div
      className="mx-2 mb-2 rounded-xl border border-amber-500/40 bg-amber-500/10 text-foreground overflow-hidden transition-all shadow-sm"
      role="region"
      aria-label="Outstanding reminders awaiting acknowledgement"
    >
      <div className="flex items-center justify-between px-3 py-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="p-1 rounded bg-amber-500/20 text-amber-300 shrink-0 animate-pulse" aria-hidden="true">
            <Bell className="w-3.5 h-3.5" />
          </span>
          <span className="font-medium text-amber-200 truncate">
            {outstandingCount} {outstandingCount === 1 ? 'reminder' : 'reminders'} awaiting acknowledgement
          </span>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-[11px] font-mono text-amber-300 hover:text-amber-100 px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 transition-colors"
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide outstanding reminders' : 'Show outstanding reminders'}
        >
          <span>{expanded ? 'Hide' : 'Review'}</span>
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-amber-500/20 px-3 py-2 space-y-2 bg-background/50 max-h-48 overflow-y-auto">
          {outstandingRecords.map((rec) => (
            <div
              key={rec.eventId}
              className="flex items-center justify-between gap-2 p-2 rounded-lg bg-card/60 border border-border/50 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground truncate">
                  {rec.title || 'Reminder'}
                </div>
                <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Clock className="w-2.5 h-2.5" aria-hidden="true" />
                  <span>{(rec.dueAt ? new Date(rec.dueAt).toLocaleTimeString() : 'Delivered')}</span>
                </div>
              </div>
              <button
                onClick={() => handleItemAcknowledge(rec.eventId, rec.reminderId)}
                disabled={processingId === rec.eventId}
                aria-label={`Acknowledge reminder: ${rec.title || 'reminder'}`}
                className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 active:scale-95 disabled:opacity-50 transition-all min-h-[36px]"
              >
                {processingId === rec.eventId ? (
                  <RefreshCw className="w-3 h-3 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="w-3 h-3" aria-hidden="true" />
                )}
                <span>Acknowledge</span>
              </button>
            </div>
          ))}
          {actionError && (
            <div className="text-[11px] text-destructive px-1" role="alert">
              {actionError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
