#!/bin/sh
# Every tracked file that is not plain text (images) must not carry a local path or a private name.
# Runs `strings` over each one and fails on /Users/, /home/ or C:\Users.
set -e
cd "$(dirname "$0")/../.."
bad=0
git ls-files -z | while IFS= read -r -d '' f; do
  if ! LC_ALL=C grep -Iq . "$f" 2>/dev/null; then
    if strings -a "$f" | grep -nE '/Users/|/home/[a-z]|[A-Za-z]:\\Users\\' > /tmp/scan-bin.$$ 2>/dev/null; then
      echo "✖ $f:"; sed 's/^/    /' /tmp/scan-bin.$$; bad=1
    fi
  fi
  [ $bad = 0 ] || exit 1
done
echo "binaries ok"
