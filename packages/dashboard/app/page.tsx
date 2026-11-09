import { OverviewView } from '../components/OverviewView.tsx';
import { pool } from '../lib/db.ts';
import { DEFAULT_RANGE, isRangeKey, lastErrors, overview } from '../lib/queries.ts';
import { requireSession } from '../lib/session.ts';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<{ range?: string | string[] }> }) {
  await requireSession();
  const { range } = await searchParams;
  const key = isRangeKey(range) ? range : DEFAULT_RANGE;
  const db = pool();
  const [data, errors] = await Promise.all([overview(db, key, new Date()), lastErrors(db, 50)]);
  return <OverviewView data={data} errors={errors} />;
}
