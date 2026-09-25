import type { ExecutionCheckpoint, StorageEngine, Task } from '../core/index.js';
import {
  CheckpointRejectedError,
  freeze,
  materializeCheckpoint,
  validateCheckpoint,
} from '../core/index.js';

export class InMemoryStorage implements StorageEngine {
  private readonly items = new Map<string, Task>();
  private readonly checkpoints = new Map<string, ExecutionCheckpoint>();

  get(id: string) {
    return this.items.get(id);
  }

  put(task: Task) {
    this.items.set(task.id, freeze(task));
  }

  delete(id: string) {
    this.items.delete(id);
  }

  list() {
    return Object.freeze([...this.items.values()]);
  }

  /**
   * Atomic replacement. The incoming checkpoint is validated, materialised into a
   * fresh immutable snapshot (unknown/extra fields are dropped, so nothing
   * outside the schema can be persisted), compared against the stored version,
   * and installed with a single Map.set. A rejected write leaves the stored
   * checkpoint untouched.
   */
  saveCheckpoint(checkpoint: ExecutionCheckpoint): void {
    const validation = validateCheckpoint(checkpoint);
    if (!validation.valid) {
      throw new CheckpointRejectedError(validation.reason);
    }
    const stored = this.checkpoints.get(checkpoint.taskId);
    if (stored !== undefined) {
      if (checkpoint.taskVersion < stored.taskVersion) {
        throw new CheckpointRejectedError(
          `stale checkpoint rejected: taskVersion ${checkpoint.taskVersion} is older than stored ${stored.taskVersion}`,
        );
      }
      if (
        checkpoint.taskVersion === stored.taskVersion &&
        checkpoint.activeStepIndex < stored.activeStepIndex
      ) {
        throw new CheckpointRejectedError(
          `stale checkpoint rejected: activeStepIndex ${checkpoint.activeStepIndex} regresses stored ${stored.activeStepIndex} at taskVersion ${checkpoint.taskVersion}`,
        );
      }
    }
    this.checkpoints.set(checkpoint.taskId, materializeCheckpoint(checkpoint));
  }

  /** Immutable snapshot; internal state is never exposed. */
  loadCheckpoint(taskId: string): ExecutionCheckpoint | undefined {
    const stored = this.checkpoints.get(taskId);
    if (stored === undefined) return undefined;
    const validation = validateCheckpoint(stored, taskId);
    if (!validation.valid) {
      throw new CheckpointRejectedError(validation.reason);
    }
    return materializeCheckpoint(stored);
  }

  deleteCheckpoint(taskId: string): void {
    this.checkpoints.delete(taskId);
  }
}

