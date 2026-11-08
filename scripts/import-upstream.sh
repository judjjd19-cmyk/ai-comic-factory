#!/bin/sh
set -eu

UPSTREAM_URL="https://github.com/jbilcke-hf/ai-comic-factory.git"
UPSTREAM_BRANCH="main"
TARGET_BRANCH="upstream-import"

: "${CI_JOB_TOKEN:?GitLab CI_JOB_TOKEN is required}"
: "${CI_PROJECT_PATH:?GitLab CI_PROJECT_PATH is required}"
: "${CI_SERVER_HOST:?GitLab CI_SERVER_HOST is required}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT HUP INT TERM
TARGET_URL="https://gitlab-ci-token:${CI_JOB_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git"

if [ -n "$(git ls-remote --heads "$TARGET_URL" "refs/heads/$TARGET_BRANCH")" ]; then
  echo "Refusing to overwrite existing branch $TARGET_BRANCH" >&2
  exit 1
fi

git clone --single-branch --branch "$UPSTREAM_BRANCH" "$UPSTREAM_URL" "$WORKDIR/upstream"
git -C "$WORKDIR/upstream" push "$TARGET_URL" "HEAD:refs/heads/$TARGET_BRANCH"
printf 'Imported upstream commit %s into %s\n' "$(git -C "$WORKDIR/upstream" rev-parse HEAD)" "$TARGET_BRANCH"
