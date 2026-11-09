export function Tile({ label, value, unit, note }: { label: string; value: string; unit?: string; note?: string }) {
  return (
    <div className="tile">
      <dt>{label}</dt>
      <dd>
        <span className="tile-value num">{value}</span>
        {unit ? <span className="tile-unit">{unit}</span> : null}
      </dd>
      {note ? <dd className="tile-note">{note}</dd> : null}
    </div>
  );
}
