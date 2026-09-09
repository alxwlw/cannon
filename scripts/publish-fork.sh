#!/usr/bin/env bash
# Publishes packages/builder and packages/cli of alxwlw/cannon as @alxwlw/cannon-{builder,cli}.
# Manifest shape mirrors what 2.26.1-nonce.1 was published with: renamed, versioned, cli's builder
# dependency turned into the npm: alias, scripts/devDependencies stripped, repo URLs on the fork.
# Usage: VERSION=2.26.1-nonce.2 [TAG=nonce] [DRY_RUN=1] scripts/publish-fork.sh
set -euo pipefail
: "${VERSION:?VERSION=2.26.1-nonce.N}"
TAG="${TAG:-nonce}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO='{"type":"git","url":"git+https://github.com/alxwlw/cannon.git"}'

publish() {
  local dir="$1" filter="$2"
  cd "$ROOT/packages/$dir"
  cp package.json package.json.orig
  trap 'mv -f "$ROOT/packages/'"$dir"'/package.json.orig" "$ROOT/packages/'"$dir"'/package.json"' EXIT
  jq --arg v "$VERSION" --argjson repo "$REPO" "$filter"' | .version=$v | .repository=$repo
      | .bugs={url:"https://github.com/alxwlw/cannon/issues"} | .homepage="https://github.com/alxwlw/cannon#readme"
      | .publishConfig={access:"public"} | del(.scripts, .devDependencies)' package.json.orig > package.json
  if [ -n "${DRY_RUN:-}" ]; then
    jq -c '{name, version, types, builder: .dependencies["@usecannon/builder"]}' package.json
    npm pack --dry-run --json | jq -r '.[] | "  \(.filename): \(.entryCount) files, \(.unpackedSize) bytes unpacked"'
  else
    npm publish --tag "$TAG" --access public
  fi
  mv -f package.json.orig package.json; trap - EXIT
}

cd "$ROOT" && pnpm -r --filter @usecannon/builder --filter @usecannon/cli run build
publish builder '.name="@alxwlw/cannon-builder"'
publish cli '.name="@alxwlw/cannon-cli" | .types="./dist/src/index.d.ts"
  | .dependencies["@usecannon/builder"]="npm:@alxwlw/cannon-builder@"+$v'
echo "published @alxwlw/cannon-{builder,cli}@$VERSION under dist-tag $TAG"
