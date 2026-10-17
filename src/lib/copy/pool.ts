/**
 * Runs `task` for every item, at most `size` at a time.
 *
 * The old way was "take 24 followers, wait until all 24 are done, take the next 24":
 * one slow broker call held back every follower of the next batch. Here a new item
 * starts the moment ANY running one finishes, so a slow call delays only itself.
 *
 * Every item is processed even if some tasks throw; the first error is raised at the
 * end (so one failing follower can never leave the followers behind it untouched).
 *
 * Pure: no Node APIs, no imports. Shared with the AWS workers.
 */
export async function runPool<T>(
  items: readonly T[],
  size: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const total = items.length;
  if (total === 0) return;
  const limit = Math.max(1, Math.min(total, Math.floor(Number(size)) || 1));

  let next = 0;
  let failed = false;
  let firstError: unknown;

  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= total) return;
      try {
        await task(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  };

  const lanes: Promise<void>[] = [];
  for (let count = 0; count < limit; count += 1) lanes.push(lane());
  await Promise.all(lanes);
  if (failed) throw firstError;
}
