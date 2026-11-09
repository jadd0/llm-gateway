export function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <dt>{label}</dt>
      <dd>
        <span className="tile-value num">{value}</span>
      </dd>
      {note ? <dd className="tile-note">{note}</dd> : null}
    </div>
  );
}
