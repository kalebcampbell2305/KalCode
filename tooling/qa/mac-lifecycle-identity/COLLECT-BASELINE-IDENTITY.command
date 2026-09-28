#!/bin/zsh -f
# Read-only QA2 lifecycle identity capture for the RETAINED BASELINE (checkpoints B0 and rollback).
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
here=${0:A:h}
if ! /usr/bin/xcode-select -p >/dev/null 2>&1; then
  print -u2 -- 'Apple Command Line Tools (python3) are unavailable; stop and report to Primary. Nothing collected.'
  exit 2
fi
print -- 'Baseline checkpoint:  1) B0 - initial retained baseline   2) rollback - after "Confirm restore and restart"'
read -r 'choice?Enter 1 or 2: '
case "$choice" in
  1) step=B0 ;;
  2) step=rollback ;;
  *) print -u2 -- 'No checkpoint selected; nothing collected.'; exit 2 ;;
esac
/usr/bin/python3 -I -B "$here/collect_lifecycle_identity.py" --role baseline --step "$step"
exit $?
