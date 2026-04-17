#!/bin/bash
# Auto-commit and push any changes after Claude edits files
cd "C:/Users/13065/Desktop/Business"

# Only run if there are changes
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  git add -A
  git commit -m "Auto-update: $(date '+%Y-%m-%d %H:%M')" --allow-empty-message 2>/dev/null || true
  git push origin main 2>/dev/null || true
fi
