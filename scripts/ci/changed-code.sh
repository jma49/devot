#!/bin/sh
# CI helper: reads the names of the files a pull request changes, one per
# line, on stdin and prints `code=false` when every one is documentation (a
# file under docs/ or any Markdown file), else `code=true`. Used by
# .github/workflows/ci.yml to skip the build and test jobs for documentation
# alone. A list with no files counts as code, so a doubt runs everything.
code=false
seen=false
while IFS= read -r file; do
  [ -n "$file" ] || continue
  seen=true
  case "$file" in
    docs/* | *.md) ;;
    *) code=true ;;
  esac
done
[ "$seen" = true ] || code=true
echo "code=$code"
