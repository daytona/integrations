#!/bin/bash

set -eu

errors=0

# Fail the lint when the package imports from langchain, langchain_experimental,
# or langchain_community. Documentation samples (docs/ and Markdown files) are
# excluded so example snippets don't trigger false failures.
check_banned_import() {
    local pattern="$1"
    local output status

    status=0
    output=$(git --no-pager grep -nE "$pattern" -- . ':!docs' ':!*.md') || status=$?

    if [ "$status" -eq 0 ]; then
        printf '%s\n' "$output"
        errors=$((errors + 1))
    elif [ "$status" -ne 1 ]; then
        # git grep uses exit code 1 for "no matches"; anything else is a real
        # failure that must not be silently swallowed into a passing lint.
        echo "error: 'git grep' failed with exit code $status" >&2
        exit "$status"
    fi
}

check_banned_import '^[[:space:]]*(from|import) langchain\b'
check_banned_import '^[[:space:]]*(from|import) langchain_experimental\b'
check_banned_import '^[[:space:]]*(from|import) langchain_community\b'

# Decide on an exit status based on the errors
if [ "$errors" -gt 0 ]; then
    exit 1
else
    exit 0
fi
