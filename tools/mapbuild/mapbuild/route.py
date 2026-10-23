"""Fastest car route between two points over the extract's road network (Dijkstra, one-way streets respected)."""
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components, dijkstra
from scipy.spatial import cKDTree


def fastest(car, start, end):
    """car: Features.car; start, end: local (x, y). Returns [(x, y), ...] or [] if the two are not connected."""
    if not car:
        return []
    ids = np.unique(np.concatenate([w[0] for w in car]))
    xy = np.zeros((len(ids), 2))
    src, dst, cost = [], [], []
    for nodes, pts, kmh, oneway in car:
        k = np.searchsorted(ids, nodes)
        xy[k] = pts
        t = np.hypot(*np.diff(pts, axis=0).T) / (kmh / 3.6)  # seconds per segment
        if oneway >= 0:
            src.append(k[:-1]), dst.append(k[1:]), cost.append(t)
        if oneway <= 0:
            src.append(k[1:]), dst.append(k[:-1]), cost.append(t)
    n = len(ids)
    # duplicate edges (two ways sharing a segment) are summed by coo → csr; keep the cheaper one instead
    s, d, c = np.concatenate(src), np.concatenate(dst), np.maximum(np.concatenate(cost), 1e-3)
    order = np.lexsort((c, d, s))
    s, d, c = s[order], d[order], c[order]
    first = np.ones(len(s), bool)
    first[1:] = (s[1:] != s[:-1]) | (d[1:] != d[:-1])
    g = coo_matrix((c[first], (s[first], d[first])), shape=(n, n)).tocsr()

    # snap the ends to the largest strongly connected part, not to a stray dead-end service road
    _, comp = connected_components(g, directed=True, connection="strong")
    main = np.flatnonzero(comp == np.bincount(comp).argmax())
    tree = cKDTree(xy[main])
    a, b = main[tree.query(start)[1]], main[tree.query(end)[1]]
    dist, pred = dijkstra(g, indices=a, return_predecessors=True)
    if not np.isfinite(dist[b]):
        return []
    path = [b]
    while path[-1] != a:
        path.append(pred[path[-1]])
    return [tuple(xy[i]) for i in reversed(path)]
