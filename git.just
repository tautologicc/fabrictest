set default-list := true

# Add a public key to the allowlist and re-sign it
add-signing-key principal keyfile: && sign-allowlist
    #!/bin/sh -eu
    log() { printf "$@"; printf '\n'; }
    die() { log "$@" >&2; exit 1; }
    allowlist=$(git config --path gpg.ssh.allowedSignersFile)
    [ -n "$allowlist" ] || die 'gpg.ssh.allowedSignersFile is not configured'
    [ -f "$allowlist" ] || die 'missing allowlist: %s' "$allowlist"
    principal='{{principal}}'
    keyfile='{{keyfile}}'
    [ -n "$principal" ] || die 'principal is required'
    [ -f "$keyfile" ] || die 'public key not found: %s' "$keyfile"
    keytype=
    keydata=
    read -r keytype keydata _ < "$keyfile" || :
    { [ -n "$keytype" ] && [ -n "$keydata" ]; } ||
        die 'invalid public key: %s' "$keyfile"
    { ! grep -Fq " $keydata" "$allowlist"; } ||
        die 'key already present in %s' "$allowlist"
    nl=
    if [ -s "$allowlist" ] && [ -n "$(tail -c 1 "$allowlist")" ]; then
        nl='\n'
    fi
    printf '%s%s %s %s\n' "$nl" "$principal" "$keytype" "$keydata" >> "$allowlist"
    log 'added %s' "$principal"

# Sign the allowlist with the SSH key
[private]
sign-allowlist:
    #!/bin/sh -eu
    log() { printf "$@" ; printf '\n'; }
    die() { log "$@" >&2; exit 1; }
    allowlist=$(git config --path gpg.ssh.allowedSignersFile)
    [ -n "$allowlist" ] || die 'gpg.ssh.allowedSignersFile is not configured'
    [ -f "$allowlist" ] || die 'missing allowlist: %s' "$allowlist"
    sig="${allowlist}.sig"
    key=$(git config --path user.signingkey)
    [ -n "$key" ] || die 'user.signingkey is not configured'
    [ -f "$key" ] || die 'signing key not found: %s' "$key"
    tmp=$(mktemp)
    trap 'rm -f "$tmp" "${tmp}.sig"' EXIT
    cp "$allowlist" "$tmp"
    ssh-keygen -Y sign -f "$key" -n git "$tmp"
    mv "${tmp}.sig" "$sig"
    log 'wrote %s' "$sig"

# Verify the allowlist signature, then signatures on unpushed commits (or a given range)
verify-signatures range='':
    #!/bin/sh -eu
    log() { printf "$@"; printf '\n'; }
    die() { log "$@" >&2; exit 1; }
    allowlist=$(git config --path gpg.ssh.allowedSignersFile)
    [ -n "$allowlist" ] || die 'gpg.ssh.allowedSignersFile is not configured'
    [ -f "$allowlist" ] || die 'missing allowlist: %s' "$allowlist"
    sig="${allowlist}.sig"
    [ -f "$sig" ] ||
        die "allowlist is missing signature: %s; run 'just git sign-allowlist'" "$sig"
    email=$(git config user.email)
    [ -n "$email" ] || die 'user.email is not configured'
    ssh-keygen -Y verify \
        -f "$allowlist" \
        -I "$email" \
        -n git \
        -s "$sig" \
        < "$allowlist" || die 'invalid %s' "$sig"
    range='{{range}}'
    upstream=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || true)
    if [ -n "$range" ]; then
        set -- "$range"
    elif [ -n "$upstream" ]; then
        set -- "$upstream..HEAD"
    else
        set -- HEAD --not --remotes
    fi
    count=$(git rev-list --count "$@") || die 'cannot list commits: %s' "$*"
    unsigned=$(git log --format='%h %G? %s' "$@" | awk '$2 != "G"')
    [ -z "$unsigned" ] ||
        die 'Unsigned or unverifiable commits:\n\n%s' "$unsigned"
    log '%s commits verified' "$count"

# Check messages on unpushed commits (or a given range)
check-commit-messages range='':
    #!/bin/sh -eu
    range='{{range}}'
    upstream=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || :)
    if [ -n "$range" ]; then
        set -- "$range"
    elif [ -n "$upstream" ]; then
        set -- "$upstream..HEAD"
    else
        set -- HEAD --not --remotes
    fi
    .pi/skills/scopedcommits/scripts/check-commit-messages.mjs -- "$@"
