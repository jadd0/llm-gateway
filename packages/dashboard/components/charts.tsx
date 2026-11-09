'use client';

import type { ReactElement } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtMs, fmtPct, fmtTick, fmtUsd } from '../lib/format.ts';
import type { SpendBar } from '../lib/spend.ts';
import type { Point } from '../lib/queries.ts';

// Recharts draws in SVG, so colours come from the page's CSS variables and follow light and dark.
const ACCENT = 'var(--accent)';
const NEUTRAL = 'var(--series-2)';
const GRID = 'var(--border)';
const TEXT = 'var(--muted)';
const HEIGHT = 280;

/**
 * Fills its parent's width. Recharts measures the box in the browser, so the server sends an empty frame of the
 * right height and the chart draws on load.
 */
function Sized({ height, children }: { height: number; children: ReactElement<{ width?: number; height?: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={height} initialDimension={{ width: 640, height }}>
      {children}
    </ResponsiveContainer>
  );
}
const tick = { fill: TEXT, fontSize: 12 };

interface Axes {
  from: number;
  to: number;
  stepMs: number;
}

const timeAxis = ({ from, to, stepMs }: Axes) => (
  <XAxis dataKey="t" type="number" scale="time" domain={[from, to]} tickFormatter={(t: number) => fmtTick(t, stepMs)} tick={tick} stroke={GRID} tickCount={6} minTickGap={24}
    label={{ value: 'Time (UTC)', position: 'insideBottom', offset: 4, fill: TEXT, fontSize: 12 }} height={56} />
);

const tooltip = (labelFmt: (t: number) => string, valueFmt: (v: number) => string) => (
  <Tooltip
    labelFormatter={(t) => labelFmt(Number(t))}
    formatter={(v) => (typeof v === 'number' ? valueFmt(v) : String(v ?? ''))}
    contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12 }}
    labelStyle={{ color: 'var(--text)' }}
  />
);

export function LatencyChart({ points, ...axes }: { points: Point[] } & Axes) {
  return (
    <Sized height={HEIGHT}>
      <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        {timeAxis(axes)}
        <YAxis tick={tick} stroke={GRID} width={64} tickFormatter={(v: number) => fmtMs(v)} label={{ value: 'Latency', angle: -90, position: 'insideLeft', fill: TEXT, fontSize: 12 }} />
        {tooltip((t) => fmtTick(t, axes.stepMs), fmtMs)}
        <Legend verticalAlign="top" height={28} />
        <Line type="monotone" dataKey="p50" name="p50" stroke={NEUTRAL} strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="p95" name="p95" stroke={ACCENT} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </Sized>
  );
}

function RateChart({ points, field, name, ...axes }: { points: Point[]; field: 'errorRate' | 'cacheHitRate'; name: string } & Axes) {
  return (
    <Sized height={HEIGHT}>
      <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        {timeAxis(axes)}
        <YAxis tick={tick} stroke={GRID} width={64} domain={[0, 'auto']} tickFormatter={(v: number) => fmtPct(v)} label={{ value: field === 'errorRate' ? 'Error rate' : 'Hit rate', angle: -90, position: 'insideLeft', fill: TEXT, fontSize: 12 }} />
        {tooltip((t) => fmtTick(t, axes.stepMs), fmtPct)}
        <Legend verticalAlign="top" height={28} />
        <Line type="monotone" dataKey={field} name={name} stroke={ACCENT} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </Sized>
  );
}

export const ErrorRateChart = (p: { points: Point[] } & Axes) => <RateChart {...p} field="errorRate" name="Error rate (% of requests)" />;
export const CacheRateChart = (p: { points: Point[] } & Axes) => <RateChart {...p} field="cacheHitRate" name="Cache hit rate (% of requests)" />;

export function SpendChart({ bars }: { bars: SpendBar[] }) {
  const height = Math.max(HEIGHT, bars.length * 28 + 70);
  return (
    <Sized height={height}>
      <BarChart data={bars} layout="vertical" margin={{ top: 8, right: 24, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" tick={tick} stroke={GRID} tickFormatter={(v: number) => fmtUsd(v * 1_000_000)} height={56}
          label={{ value: 'Spend (USD)', position: 'insideBottom', offset: 4, fill: TEXT, fontSize: 12 }} />
        <YAxis type="category" dataKey="name" tick={tick} stroke={GRID} width={112} interval={0} />
        <Tooltip formatter={(v) => (typeof v === 'number' ? fmtUsd(v * 1_000_000) : String(v ?? ''))} cursor={{ fill: 'var(--hover)' }}
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12 }} />
        <Legend verticalAlign="top" height={28} />
        <Bar dataKey="usd" name="Spend in range (USD)" fill={ACCENT} isAnimationActive={false} radius={[0, 3, 3, 0]} />
      </BarChart>
    </Sized>
  );
}
