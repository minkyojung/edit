# Google OAuth credentials

`google_oauth.rs` reads its Desktop-client credentials from two files in this
directory at **compile time** (`include_str!`). They are **gitignored** so the
values never land in git history (GitHub push protection blocks them otherwise —
and secrets in history are hard to purge later, even in a private repo).

Create both before building:

```
secrets/google_client_id       # the OAuth client id (…apps.googleusercontent.com)
secrets/google_client_secret   # the OAuth client secret
```

Get them from Google Cloud Console → the `Octave-note` project → **Clients** →
the Desktop client. Trailing whitespace/newlines are trimmed, so a plain
one-line file is fine.

Note: for a Desktop (installed) app the client secret is **not confidential**
(RFC 8252) — PKCE is what protects the flow. These files only keep the values
out of the committed source; the built binary still embeds them, which is
expected and safe for a native app.

For CI / release builds, write these two files in the build step (e.g. from a
CI secret) before `cargo build`. A missing file is a **loud compile error** by
design, so a build can never silently ship without credentials.
