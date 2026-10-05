# The eye correcting the hand: integrate each gesture, compare the path it
# makes with the line it is meant to follow, and steer: the first push whose
# end strays sideways from the line gets its turn adjusted, then the next
# pass judges the pushes after it (as a hand is steered from where it is).
# Only the pushes change; what is stored is still a motion.
#   steer.py run batch.json paths.json [iters]
# paths.json: {label: [[x mm, y mm], ...]} the line each gesture should
# follow; each gesture needs "_dir0" (its launch heading along the line;
# removed when done). Repeats are judged by their first copy, launched from
# the line's start. Typically converges to ~0.3 mm in 10-30 passes.
import sys, json, math, subprocess, os
W, H = 304.8, 228.6
run, bf, pf = sys.argv[1], sys.argv[2], sys.argv[3]; iters = int(sys.argv[4]) if len(sys.argv) > 4 else 5
A = json.load(open(bf)); paths = json.load(open(pf))   # paths: label -> [[x mm, y mm], ...]
tmp = os.path.join(os.path.dirname(pf), 'refine-tmp.json'); dump = os.path.join(os.path.dirname(pf), 'refine-dump.json')
def arc(P):
    S = [0.0]
    for a, b in zip(P, P[1:]): S.append(S[-1] + math.dist(a, b))
    return S
def at(P, S, s):
    s = min(max(s, 0), S[-1])
    for i in range(1, len(S)):
        if S[i] >= s:
            f = (s - S[i - 1]) / ((S[i] - S[i - 1]) or 1); return (P[i - 1][0] + (P[i][0] - P[i - 1][0]) * f, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * f), i
    return P[-1], len(P) - 1
def report(errs): return ' '.join(f'{e:.1f}' for e in errs)
for it in range(iters + 1):
    probe = []
    for a in A:
        b = dict(a); b.pop('repeat', None); b.pop('follow', None)
        C = paths.get(a['label'])
        if C: b['start'] = [C[0][0] / W, C[0][1] / H]; b['v0'] = dict(a['v0']); b['v0']['dir'] = a['_dir0']
        probe.append(b)
    json.dump(probe, open(tmp, 'w'))
    subprocess.run(['node', '.claude/skills/paint/scripts/ink.mjs', 'preview', run, tmp, '--dump', dump], capture_output=True)
    D = json.load(open(dump)); first = {}
    for d in D: first.setdefault(d['g'], d)
    errs = []
    for gi, a in enumerate(A):
        C = paths.get(a['label'])
        if not C or gi not in first: continue
        T = [(x * W, y * H) for x, y in first[gi]['pts']]; TT = first[gi]['ts']; SC = arc(C)
        def at_t(t):
            for i in range(1, len(TT)):
                if TT[i] >= t:
                    f = (t - TT[i - 1]) / ((TT[i] - TT[i - 1]) or 1); return (T[i - 1][0] + (T[i][0] - T[i - 1][0]) * f, T[i - 1][1] + (T[i][1] - T[i - 1][1]) * f)
            return T[-1]
        def near(pt, s_guess):
            best = None
            for k in range(len(C) - 1):
                if abs(SC[k] - s_guess) > 25: continue
                ax, ay = C[k]; bx, by = C[k + 1]; dx, dy = bx - ax, by - ay; l2 = dx * dx + dy * dy or 1
                u = max(0, min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / l2))
                qx, qy = ax + dx * u, ay + dy * u; d = math.hypot(pt[0] - qx, pt[1] - qy)
                if best is None or d < best[0]:
                    n = math.sqrt(l2); e = (dx * (pt[1] - ay) - dy * (pt[0] - ax)) / n
                    best = (d, e, SC[k] + u * n)
            return best or (0, 0, s_guess)
        v = a['v0']['speed']; t = 0; s = 0; maxe = 0; fixed = False
        for p in a['pushes']:
            L = v * p['ms'] / 1000; t += p['ms']; s += L
            d, e, sn = near(at_t(t), s)
            maxe = max(maxe, abs(e))
            if it < iters and not fixed and abs(e) > 0.35:
                delta = max(-0.4, min(0.4, -0.8 * 2 * e / max(L, 3)))
                p.pop('along', None); p['turn'] = round(p.get('turn', 0) + v * v * delta / max(L, 3))
                fixed = True
        # the length: where along the line the stroke ends
        d, e, sn = near(T[-1], SC[-1])
        if it < iters and not fixed and abs(SC[-1] - sn) > 0.8:
            last = a['pushes'][-1]; last['ms'] = max(10, round(last['ms'] + 1000 * (SC[-1] - sn) / v * 0.8))
        maxe = max(maxe, abs(SC[-1] - sn) * 0.5)
        errs.append(maxe)
    if it % 5 == 0 or it == iters or max(errs) < 0.6: print(f'pass {it}: worst sideways error per gesture (mm): {report(errs)}')
    if max(errs) < 0.6: break
for a in A: a.pop('_dir0', None)
open(bf, 'w').write('[\n' + ',\n'.join(' ' + json.dumps(a) for a in A) + '\n]\n')
