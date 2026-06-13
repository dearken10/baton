#!/usr/bin/env bash
#
# poc/maestro/checkpoint-rehearsal.sh
#
# Demonstrates the F15.6 reversibility primitive in isolation, against
# a worktree of your choice. No LLM, no IPC, no baton involvement.
#
#   Usage:
#     ./checkpoint-rehearsal.sh checkpoint <worktree-path>
#     ./checkpoint-rehearsal.sh revert    <action-id>
#     ./checkpoint-rehearsal.sh list
#
# State lives in ~/.baton/maestro-poc.tsv (action_id\tworktree\tstash).
# Tags written are named baton/maestro/<action-id>/pre.

set -euo pipefail

LEDGER="${HOME}/.baton/maestro-poc.tsv"
mkdir -p "$(dirname "$LEDGER")"
touch "$LEDGER"

cmd_checkpoint() {
  local wt="${1:?worktree path required}"
  wt="$(cd "$wt" && pwd)"
  local id
  id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  local tag="baton/maestro/${id}/pre"
  (
    cd "$wt"
    git tag "$tag" HEAD
    # `git stash create` builds a stash commit object but does NOT
    # touch the index or working tree. Safe to run before a Maestro
    # action; the stash ref is recorded in the ledger so revert can
    # find it.
    local stash
    if ! stash="$(git stash create 2>/dev/null)"; then
      stash=""
    fi
    printf '%s\t%s\t%s\n' "$id" "$wt" "${stash:-}" >> "$LEDGER"
    echo "checkpoint $id"
    echo "  worktree: $wt"
    echo "  tag:      $tag"
    echo "  stash:    ${stash:-(clean)}"
    echo "  revert:   $0 revert $id"
  )
}

cmd_revert() {
  local id="${1:?action-id required}"
  local row
  row="$(awk -v id="$id" -F '\t' '$1==id {print; exit}' "$LEDGER" || true)"
  if [[ -z "$row" ]]; then
    echo "no action $id in $LEDGER" >&2
    exit 2
  fi
  IFS=$'\t' read -r _ wt stash <<< "$row"
  local tag="baton/maestro/${id}/pre"
  (
    cd "$wt"
    echo "reverting $id in $wt"
    git reset --hard "$tag"
    if [[ -n "$stash" ]]; then
      echo "  applying stash $stash"
      git stash apply "$stash"
    fi
    git tag -d "$tag" >/dev/null
  )
  # Remove the row from the ledger.
  local tmp
  tmp="$(mktemp)"
  awk -v id="$id" -F '\t' '$1!=id' "$LEDGER" > "$tmp"
  mv "$tmp" "$LEDGER"
  echo "reverted."
}

cmd_list() {
  if [[ ! -s "$LEDGER" ]]; then
    echo "(no checkpoints)"
    return
  fi
  printf '%-36s  %s\n' 'action_id' 'worktree'
  while IFS=$'\t' read -r id wt _; do
    printf '%-36s  %s\n' "$id" "$wt"
  done < "$LEDGER"
}

case "${1:-}" in
  checkpoint) shift; cmd_checkpoint "$@" ;;
  revert)     shift; cmd_revert "$@" ;;
  list)       cmd_list ;;
  *)
    echo "usage: $0 {checkpoint <wt> | revert <id> | list}" >&2
    exit 64
    ;;
esac
