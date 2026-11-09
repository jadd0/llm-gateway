import type { Embedded, Embedder } from './embedder.ts';

export const DIMENSIONS = 1024;

/** A unit vector at `degrees` from the first axis in the plane of the first two: two of them have cosine similarity cos(difference). */
export function angle(degrees: number): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  const r = (degrees * Math.PI) / 180;
  v[0] = Math.cos(r);
  v[1] = Math.sin(r);
  return v;
}

/** The angle whose cosine with angle(0) is `similarity`. */
export const atSimilarity = (similarity: number): number[] => angle((Math.acos(similarity) * 180) / Math.PI);

/**
 * An embedder that answers from a table of fixed vectors, so a test says exactly how similar two prompts are.
 * A text that is not in the table is a failure (undefined). `gate` holds every answer until released.
 */
export function stubEmbedder(table: Record<string, number[]>, name = 'voyage-4-lite') {
  const calls: Array<{ text: string; patient: boolean }> = [];
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  let gatePatientOnly = false;
  const embedder: Embedder = {
    async embed(text, options): Promise<Embedded | undefined> {
      calls.push({ text, patient: options?.patient === true });
      if (gate && (!gatePatientOnly || options?.patient)) await gate;
      const vector = table[text];
      return vector ? { vector, embedder: name } : undefined;
    },
  };
  return {
    embedder,
    calls,
    /** Holds every answer (or, with `patientOnly`, only the fill's) until `release`. */
    hold(patientOnly = false) {
      gatePatientOnly = patientOnly;
      gate = new Promise<void>((r) => (release = r));
    },
    release() {
      release?.();
      gate = undefined;
    },
  };
}
