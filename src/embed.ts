import type { Env } from './types';

// Embeddings via Workers AI bge-m3 (multilingue FR/EN, 1024 dims).
// Stockés normalisés en BLOB float32 dans D1 ; la similarité cosinus
// se réduit alors à un produit scalaire.

const MODEL = '@cf/baai/bge-m3';
export const DIMS = 1024;

export async function embedTexts(env: Env, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 20) {
    const chunk = texts.slice(i, i + 20);
    const res: any = await (env.AI as any).run(MODEL, { text: chunk });
    const data: number[][] = res?.data ?? res?.result?.data ?? [];
    if (data.length !== chunk.length) {
      throw new Error(`embeddings: ${data.length} vecteurs pour ${chunk.length} textes`);
    }
    for (const v of data) out.push(normalize(Float32Array.from(v)));
  }
  return out;
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Produit scalaire = cosinus pour des vecteurs normalisés. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function toBlob(v: Float32Array): ArrayBuffer {
  return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}

/** D1 renvoie les BLOB en ArrayBuffer (ou number[] sur d'anciennes versions). */
export function fromBlob(raw: unknown): Float32Array | null {
  if (!raw) return null;
  if (raw instanceof ArrayBuffer) return new Float32Array(raw);
  if (ArrayBuffer.isView(raw)) {
    const u = raw as Uint8Array;
    return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
  }
  if (Array.isArray(raw)) return new Float32Array(new Uint8Array(raw).buffer);
  return null;
}
