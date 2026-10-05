#!/bin/bash
# runpass.sh RUN PASS [every]  — plan from the head's dry render and paint it
set -e
cd "$(dirname "$0")/../../../.."
RUN=$1; P=$2; EVERY=${3:-40}
HEAD=$(python3 -c "import json; r=json.load(open('paintings/$RUN/run.json')); c=r['checkpoints'][r['head']]; print(c.get('dry') or c.get('render'))")
python3 .claude/skills/paint/scripts/paintplan.py paintings/$RUN paintings/$RUN/plans/$P.json paintings/$RUN/batches/$P.json --render "$HEAD" --preview paintings/$RUN/plans/$P.png
node .claude/skills/paint/scripts/ink.mjs act $RUN paintings/$RUN/batches/$P.json --every $EVERY --note "$P" > paintings/$RUN/$P.log 2>&1 || { tail -5 /tmp/$RUN-$P.log; exit 1; }
python3 -c "import json; r=json.load(open('paintings/$RUN/run.json')); c=r['checkpoints'][r['head']]; print('$RUN $P head', r['head'], 'score', c['score']['score'], 'progress', c.get('progress'))"
