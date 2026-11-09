import { RANGES, RANGE_KEYS, type RangeKey } from '../lib/queries.ts';

export function RangePicker({ current }: { current: RangeKey }) {
  return (
    <nav aria-label="Time range" className="range">
      {RANGE_KEYS.map((k) => (
        <a key={k} href={`/?range=${k}`} aria-current={k === current ? 'page' : undefined} title={RANGES[k].label}>
          {k}
        </a>
      ))}
    </nav>
  );
}
