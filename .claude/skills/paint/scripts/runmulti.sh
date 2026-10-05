#!/bin/bash
# runmulti.sh RUN SPEC TIMES — shared-brush greedy in closed loop: plan a batch
# from the painting as it is, paint it, repeat
set -e
cd "$(dirname "$0")/../../../.."
RUN=$1; SP=$2
for i in $(seq 1 $3); do
  HEAD=$(python3 -c "import json; r=json.load(open('paintings/$RUN/run.json')); c=r['checkpoints'][r['head']]; print(c.get('dry') or c.get('render'))")
  N=$(ls paintings/$RUN/batches | grep -c "^m-" || true)
  B=paintings/$RUN/batches/m-$(printf %03d $N).json
  OUT=$(python3 .claude/skills/paint/scripts/paintmulti.py paintings/$RUN paintings/$RUN/plans/$SP.json $B --render "$HEAD" --preview paintings/$RUN/plans/m-last.png 2>/dev/null | tail -1)
  echo "$OUT"
  NS=$(echo "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['strokes'])" 2>/dev/null || echo 0)
  if [ "$NS" -lt "${MIN_STROKES:-3}" ]; then echo "$RUN $SP: nothing left worth its price"; rm -f $B; break; fi
  ZB=$(python3 -c "import json; S=json.load(open('paintings/$RUN/plans/$SP.json')); b=S.get('box'); print('--zoom-box %s --zoom-level %d --zoom-part %s' % (','.join(str(v) for v in b), int(S.get('level',1)), S.get('label','zoom').replace(' ','_')) if b else '--zoom-level 0')")
  node .claude/skills/paint/scripts/ink.mjs act $RUN $B --every 200 --note "batch $N" $ZB > paintings/$RUN/act.log 2>&1 || { tail -5 paintings/$RUN/act.log; exit 1; }
  # remember where this batch was looking (for a time-lapse that zooms with the work)
  python3 -c "
import json; r=json.load(open('paintings/$RUN/run.json')); S=json.load(open('paintings/$RUN/plans/$SP.json'))
r['checkpoints'][r['head']]['zoom']={'level': int(S.get('level', 0 if not S.get('box') else 1)), 'part': S.get('label','sheet'), 'box': S.get('box',[0,0,1,1]), 'px_per_mm': S.get('px_per_mm',3)}
json.dump(r, open('paintings/$RUN/run.json','w'), indent=1)"
  python3 -c "
import json; r=json.load(open('paintings/$RUN/run.json')); h=r['head']; c=r['checkpoints'][h]
chain=[]; x=h
while x: chain.append(x); x=r['checkpoints'][x]['parent']
print('$RUN', h, 'strokes', sum(1 for cp in chain for a in r['checkpoints'][cp]['actions'] if a.get('type')=='stroke'), 'score', c['score']['score'])"
done
