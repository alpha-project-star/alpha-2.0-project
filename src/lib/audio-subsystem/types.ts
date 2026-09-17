export type ExecutionId = string;

export interface CancellableOperation {
  id: ExecutionId;
  signal: AbortSignal;
  cancel: () => void;
}
