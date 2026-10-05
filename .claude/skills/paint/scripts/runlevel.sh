#!/bin/bash
# runlevel.sh RUN LEVEL TOP BATCHES — one zoom level: ask levels.py which tiles
# (regions / parts / features) still hold the most salience-weighted error,
# then for each, run the level's spec boxed to that tile in closed loop
set -e
cd "$(dirname "$0")/../../../.."
RUN=$1; LV=$2; TOP=${3:-6}; NB=${4:-2}
HEAD=$(python3 -c "import json; r=json.load(open('paintings/$RUN/run.json')); c=r['checkpoints'][r['head']]; print(c.get('dry') or c.get('render'))")
TILES=$(python3 .claude/skills/paint/scripts/levels.py paintings/$RUN --render "$HEAD" --level $LV --top $TOP)
echo "level $LV tiles: $TILES"
N=$(echo "$TILES" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
for i in $(seq 0 $((N-1))); do
  echo "$TILES" | python3 -c "
import json,sys; t=json.load(sys.stdin)[$i]; S=json.load(open('paintings/$RUN/plans/L$LV.json'))
S['box']=t['box']; S['label']='L$LV '+t['part']; S['seed']=S.get('seed',1)+$i; S['level']=$LV
json.dump(S,open('paintings/$RUN/plans/L$LV-t$i.json','w'))
print('tile', $i, t['part'], t['box'], 'weighted err', t['weighted_err'])"
  .claude/skills/paint/scripts/runmulti.sh $RUN L$LV-t$i $NB 2>&1 | grep -E "^$RUN|nothing" || true
done
