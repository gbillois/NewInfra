// In-memory clustering for small article sets (≤500/period).
// Builds a cosine-similarity graph, thresholds the edges, and returns
// connected components. O(N²) in both time and memory, which is fine
// at this scale (500² = 250k ops, ≈2 MB for a 1024-dim float matrix).

function l2normalize(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Union-find with path compression and union by rank.
class UnionFind {
  constructor(n) {
    this.parent = new Int32Array(n);
    this.rank = new Int8Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x) {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const nxt = this.parent[x];
      this.parent[x] = root;
      x = nxt;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
  }
}

/**
 * @param {number[][]} rawVectors  Array of N dense vectors.
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.75]  Cosine similarity above which
 *        two articles are considered in the same cluster.
 * @returns {{clusters: number[][], singletons: number[],
 *            avgIntra: number[], edges: number}}
 *   clusters: arrays of article indices (size ≥ 2), sorted by size desc.
 *   singletons: indices with no neighbours above threshold.
 *   avgIntra: for each cluster, mean intra-cluster cosine similarity.
 */
export function clusterByThreshold(rawVectors, { threshold = 0.75 } = {}) {
  const N = rawVectors.length;
  if (N === 0) return { clusters: [], singletons: [], avgIntra: [], edges: 0 };

  const vectors = rawVectors.map(l2normalize);
  const uf = new UnionFind(N);
  let edgeCount = 0;

  // Cache pairwise sims for cluster-quality metrics.
  const simMap = new Map(); // key = i*N+j (i<j) → sim
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const sim = dot(vectors[i], vectors[j]);
      if (sim >= threshold) {
        uf.union(i, j);
        simMap.set(i * N + j, sim);
        edgeCount++;
      }
    }
  }

  // Group indices by root.
  const groups = new Map();
  for (let i = 0; i < N; i++) {
    const r = uf.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const clusters = [];
  const singletons = [];
  for (const members of groups.values()) {
    if (members.length >= 2) clusters.push(members);
    else singletons.push(members[0]);
  }

  // Sort clusters by size desc, then by min index (stable display order).
  clusters.sort((a, b) => b.length - a.length || a[0] - b[0]);

  // Compute mean intra-cluster similarity for diagnostics.
  const avgIntra = clusters.map((members) => {
    let total = 0;
    let count = 0;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const i = Math.min(members[a], members[b]);
        const j = Math.max(members[a], members[b]);
        const s = simMap.get(i * N + j);
        if (s !== undefined) {
          total += s;
          count++;
        }
      }
    }
    return count ? total / count : 0;
  });

  return { clusters, singletons, avgIntra, edges: edgeCount };
}
