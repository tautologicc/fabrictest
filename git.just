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

# Verify the allowlist signature, then every commit's signature
verify-signatures:
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
    unsigned=$(git log --format='%h %G? %s' | awk '$2 != "G"')
    [ -z "$unsigned" ] ||
        die 'Unsigned or unverifiable commits:\n\n%s' "$unsigned"
    log '%s commits verified' "$(git rev-list --count HEAD)"
