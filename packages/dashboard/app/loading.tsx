export default function Loading() {
  return (
    <main className="page" aria-busy="true">
      <p className="status" role="status">
        Loading the rollups
      </p>
      <div className="skeleton tiles-skel" />
      <div className="skeleton chart-skel" />
    </main>
  );
}
