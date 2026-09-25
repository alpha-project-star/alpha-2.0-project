# Security Specification: Reminder System

## Data Invariants
1. A reminder cannot exist without a valid `userId` (or `local-user`).
2. A reminder's `dueAt` timestamp must be a positive finite number.
3. A reminder state must transition deterministically (active -> passed/completed/cancelled/acknowledged).
4. Notification state must transition atomically (pending -> claimed -> accepted -> pending).
5. User ownership of a reminder must be verified on every read/write operation within the repository.

## The "Dirty Dozen" Payloads (JSON examples to break rules)
1. { "id": "1", "userId": "attacker", "title": "Attack", "dueAt": -1, "reminderState": "active", "notificationState": "pending" } (Negative timestamp)
2. { "id": "1", "userId": "attacker", "title": "Attack", "dueAt": 9999999999999, "reminderState": "invalid", "notificationState": "pending" } (Invalid state)
3. { "id": "1", "userId": "other-user", "title": "Steal", "dueAt": 9999999999999, "reminderState": "active", "notificationState": "pending" } (ID/User mismatch)
4. { "id": "1", "userId": "local-user", "title": "", "dueAt": 9999999999999, "reminderState": "active", "notificationState": "pending" } (Empty title)
5. { "id": "1", "userId": "local-user", "title": "Attack", "dueAt": 9999999999999, "reminderState": "active", "notificationState": "invalid-state" } (Invalid notificationState)
6. { "id": "1", "userId": "local-user", "title": "Attack", "dueAt": "not-a-number", "reminderState": "active", "notificationState": "pending" } (Wrong type for dueAt)
7. { "id": "", "userId": "local-user", "title": "Attack", "dueAt": 9999999999999, "reminderState": "active", "notificationState": "pending" } (Empty ID)
8. { "id": "1", "userId": "local-user", "title": "Attack", "dueAt": 9999999999999, "reminderState": "active", "notificationState": "pending", "legacyFiredAt": "not-a-number" } (Invalid legacyFiredAt)
9. { "id": "1", "userId": "local-user", "title": "Attack", "dueAt": 9999999999999, "reminderState": "active", "notificationState": "pending", "proactiveState": "invalid" } (Invalid proactiveState)
10. { "id": "1", "userId": "local-user", "title": "Attack", "dueAt": 9999999999999, "reminderState": "active", "notificationState": "pending", "proactiveEventId": 123 } (Invalid proactiveEventId type)
11. { "id": "1", "userId": "local-user", "title": "Attack", "dueAt": 9999999999999, "reminderState": "active", "notificationState": "pending", "proactiveHandledAt": "not-a-number" } (Invalid proactiveHandledAt)
12. { "id": "1", "userId": "local-user", "title": "Attack", "dueAt": 9999999999999, "reminderState": "active", "notificationState": "pending", "proactiveMessageId": 123 } (Invalid proactiveMessageId type)
