/**
 * Thinning a long series for drawing. Pure.
 *
 * A curve drawn through hundreds of nearly identical readings looks like a hairy line, not a curve: every tiny wobble of the
 * floating result becomes a kink. Largest-Triangle-Three-Buckets (Steinarsson, 2013) keeps the first and the last point
 * and, in every bucket between them, the one point that spans the biggest triangle with its neighbours - the one that
 * matters most to the SHAPE of the line. Peaks and troughs survive, the redundant readings between them do not.
 *
 * Honesty rule (charts never invent data): the result is always a subset of the input, in the input's order. No point is
 * averaged, moved or added.
 */

export function downsampleLttb<T>(
  items: ReadonlyArray<T>,
  budget: number,
  xOf: (item: T) => number,
  yOf: (item: T) => number,
): T[] {
  const count = items.length;
  const target = Math.floor(budget);
  if (!Number.isFinite(target) || target < 3 || count <= target) return items.slice();

  const x = (item: T): number => {
    const value = xOf(item);
    return Number.isFinite(value) ? value : 0;
  };
  const y = (item: T): number => {
    const value = yOf(item);
    return Number.isFinite(value) ? value : 0;
  };

  const picked: T[] = [items[0]];
  const bucketSize = (count - 2) / (target - 2);
  let anchor = 0;

  for (let bucket = 0; bucket < target - 2; bucket += 1) {
    // the average of the NEXT bucket is the third corner of every triangle of this one
    const nextStart = Math.floor((bucket + 1) * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((bucket + 2) * bucketSize) + 1, count);
    let averageX = 0;
    let averageY = 0;
    for (let index = nextStart; index < nextEnd; index += 1) {
      averageX += x(items[index]);
      averageY += y(items[index]);
    }
    const nextLength = Math.max(1, nextEnd - nextStart);
    averageX /= nextLength;
    averageY /= nextLength;

    const start = Math.floor(bucket * bucketSize) + 1;
    const end = Math.min(Math.floor((bucket + 1) * bucketSize) + 1, count - 1);
    const anchorX = x(items[anchor]);
    const anchorY = y(items[anchor]);

    let bestArea = -1;
    let best = start;
    for (let index = start; index < end; index += 1) {
      const area =
        Math.abs((anchorX - averageX) * (y(items[index]) - anchorY) - (anchorX - x(items[index])) * (averageY - anchorY)) / 2;
      if (area > bestArea) {
        bestArea = area;
        best = index;
      }
    }
    picked.push(items[best]);
    anchor = best;
  }

  picked.push(items[count - 1]);
  return picked;
}
