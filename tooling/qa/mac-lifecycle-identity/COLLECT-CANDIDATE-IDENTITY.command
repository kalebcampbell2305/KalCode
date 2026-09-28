#!/bin/zsh -f
# Read-only QA2 lifecycle identity capture for the CANDIDATE (checkpoints update and reupdate).
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
here=${0:A:h}
if ! /usr/bin/xcode-select -p >/dev/null 2>&1; then
  print -u2 -- 'Apple Command Line Tools (python3) are unavailable; stop and report to Primary. Nothing collected.'
  exit 2
fi
print -- 'Candidate checkpoint:  1) update - first baseline-to-candidate install   2) reupdate - after rollback'
read -r 'choice?Enter 1 or 2: '
case "$choice" in
  1) step=update ;;
  2) step=reupdate ;;
  *) print -u2 -- 'No checkpoint selected; nothing collected.'; exit 2 ;;
esac
/usr/bin/python3 -I -B "$here/collect_lifecycle_identity.py" --role candidate --step "$step"
exit $?
