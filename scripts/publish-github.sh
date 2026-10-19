#!/bin/sh
# Publish a filtered copy of this repo to the public GitHub mirror.
#
# The private Gitea remote keeps the full history. GitHub gets a rewritten
# history with the author email replaced by the GitHub noreply address and the
# agent tooling (.claude, .codex, .agents, .beads) and the private spec notes
# (references.md, specification.md, specification-updates.md, implementation-plan.md,
# errors.md) and the internal docs (docs/plans, docs/verification) removed
# from every commit.
# The rewrite is deterministic, so re-running it and force-pushing keeps the
# mirror a pure function of the private history.
#
# Needs: git-filter-repo (pip install --user git-filter-repo) and a gh login
# with push rights to the mirror.
set -eu

SRC="$(cd "$(dirname "$0")/.." && pwd)"
MIRROR="${PUBLIC_MIRROR:-https://github.com/Brerlapn/logseq-expanded-clipper.git}"
BRANCH="${PUBLIC_BRANCH:-master}"
OLD_EMAIL="brerlapn@""fastmail.fm"  # split so the guard below cannot match this file
OLD_HOST="p-""hacking"
NOREPLY="Brerlapn <7059360+Brerlapn@users.noreply.github.com> <$OLD_EMAIL>"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v git-filter-repo >/dev/null 2>&1 || {
  echo "git-filter-repo not found; pip install --user git-filter-repo" >&2; exit 1; }

git clone -q --no-local --branch "$BRANCH" "$SRC" "$WORK/repo"
printf '%s\n' "$NOREPLY" > "$WORK/mailmap"
cd "$WORK/repo"
git-filter-repo --force --quiet --mailmap "$WORK/mailmap" --invert-paths \
  --path .claude --path .codex --path .agents --path .beads \
  --path references.md --path specification.md --path specification-updates.md \
  --path implementation-plan.md --path errors.md \
  --path docs/plans --path docs/verification

# Refuse to publish if anything private survived the rewrite.
if git log -p | grep -q -i -E "$OLD_EMAIL|$OLD_HOST"; then
  echo "private string found in filtered history; aborting" >&2; exit 1
fi

git remote add github "$MIRROR"
git push --force github "$BRANCH:$BRANCH"
echo "published $(git rev-parse --short HEAD) to $MIRROR ($BRANCH)"
